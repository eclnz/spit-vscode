const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECK_TIMEOUT_MS = 15000;

const pending = new Map();
const timers = new Map();
const relatedFiles = new Map();
let diagnostics;
let relatedDiagnostics;
// Where SPIT writes each product whose path no line spells out in full, from
// the last clean check of each pipeline: a label per line, by document.
const shownPaths = new Map();
let pathHintsChanged;
// What each document's latest check says to show on hover, by document: the
// version checked, executable identity, and a promise of its items by line.
const analyses = new Map();

// Semantic highlighting of a .spitout's records: each source product, and
// each dimension and value in its brackets. Pipelines and recipes are
// colored by the TextMate grammar alone.
const SEMANTIC_TOKEN_TYPES = ['variable', 'parameter', 'enumMember'];
const SEMANTIC_TOKEN_MODIFIERS = [];
const spitSemanticLegend = new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS);

// As in SPIT itself: an unquoted `#` starts a comment only at the start of a word.
function stripComment(line) {
  let quote = null;
  let escaped = false;
  let wordStart = true;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const atWordStart = wordStart;
    if (escaped) {
      escaped = false;
      wordStart = false;
      continue;
    }
    if ((quote === null || quote === '"') && character === '\\') {
      escaped = true;
      wordStart = false;
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
    } else if (quote === character) {
      quote = null;
    } else if (quote === null && character === '#' && atWordStart) {
      return line.slice(0, index);
    }
    // Whitespace as Rust's char::is_whitespace has it, which unlike `\s`
    // leaves out a byte order mark.
    wordStart = quote === null && /\p{White_Space}/u.test(character);
  }
  return line;
}

function isRecordsDocument(lines) {
  return lines.some(line => /^(?:sources|contexts(?:\s+[A-Za-z_][A-Za-z0-9_]*)?):$/.test(stripComment(line).trim()));
}

// Splits `text` on top-level occurrences of `separator`, ignoring any inside
// (), [], or <> so a generic type or a call's arguments stay one item.
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '(' || character === '[' || character === '<') depth++;
    else if (character === ')' || character === ']' || character === '>') depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push({ text: text.slice(start, index), start });
      start = index + 1;
    }
  }
  parts.push({ text: text.slice(start), start });
  return parts;
}

function trimmedRange(text) {
  const start = text.length - text.trimStart().length;
  return { value: text.trim(), start };
}

function handleInventoryLine(content, push, hasName) {
  let rest = content;
  let offset = 0;
  if (hasName) {
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (!nameMatch) return;
    push(0, nameMatch[0].length, 'variable');
    offset += nameMatch[0].length;
    rest = rest.slice(nameMatch[0].length);
  }
  const bracketStart = rest.indexOf('[');
  const bracketEnd = rest.lastIndexOf(']');
  if (bracketStart === -1 || bracketEnd === -1 || bracketEnd <= bracketStart) return;
  const innerBase = offset + bracketStart + 1;
  const inner = rest.slice(bracketStart + 1, bracketEnd);
  for (const pair of splitTopLevel(inner, ',')) {
    const eqIndex = pair.text.indexOf('=');
    if (eqIndex === -1) continue;
    const dimension = trimmedRange(pair.text.slice(0, eqIndex));
    push(innerBase + pair.start + dimension.start, dimension.value.length, 'parameter');
    const value = trimmedRange(pair.text.slice(eqIndex + 1));
    push(innerBase + pair.start + eqIndex + 1 + value.start, value.value.length, 'enumMember');
  }
}

function provideSpitSemanticTokens(document) {
  const builder = new vscode.SemanticTokensBuilder(spitSemanticLegend);
  try {
    const lineCount = document.lineCount;
    const rawLines = [];
    for (let index = 0; index < lineCount; index++) rawLines.push(document.lineAt(index).text);
    if (isRecordsDocument(rawLines)) {
      let section = null;
      for (let index = 0; index < lineCount; index++) {
        try {
          const code = stripComment(rawLines[index]);
          const indent = /^\s*/.exec(code)[0].length;
          const content = code.slice(indent).trimEnd();
          if (content === '') continue;
          const header = /^(sources|source_paths|contexts|removed)(?:\s+[A-Za-z_][A-Za-z0-9_]*)?:$/.exec(content);
          if (header) {
            section = header[1];
            continue;
          }
          const push = (start, length, type) => {
            if (length > 0 && start >= 0) {
              builder.push(index, indent + start, length, SEMANTIC_TOKEN_TYPES.indexOf(type), 0);
            }
          };
          if (section === 'sources') handleInventoryLine(content, push, true);
          else if (section === 'contexts') handleInventoryLine(content, push, false);
        } catch {
          // Best-effort highlighting: skip a line SPIT's own grammar would reject anyway.
        }
      }
    }
  } catch {
    // Fall back to whatever tokens were already built.
  }
  return builder.build();
}

function executablePath(context, document) {
  const configured = vscode.workspace.getConfiguration('spit', document.uri).get('executablePath').trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(document.uri.fsPath), configured);
  }
  const built = path.resolve(context.extensionPath, '..', 'spit', 'target', 'debug', process.platform === 'win32' ? 'spit.exe' : 'spit');
  return fs.existsSync(built) ? built : 'spit';
}

// `column` and `end_column` are 1-based UTF-16 offsets, as SPIT reports them;
// without them the whole line is marked.
function issue(document, line, message, severity = 'error', column, endColumn) {
  const index = Number.isInteger(line) ? Math.max(0, Math.min(line - 1, document.lineCount - 1)) : 0;
  const lineRange = document.lineAt(index).range;
  const range = Number.isInteger(column) && Number.isInteger(endColumn) && index === line - 1
    ? (() => {
        const length = lineRange.end.character;
        const start = Math.max(0, Math.min(column - 1, length));
        const end = Math.max(start, Math.min(endColumn - 1, length));
        return new vscode.Range(index, start, index, end);
      })()
    : lineRange;
  const level = severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  const item = new vscode.Diagnostic(range, message, level);
  item.source = 'SPIT';
  return item;
}

function stop(uri) {
  const key = uri.toString();
  clearTimeout(timers.get(key));
  timers.delete(key);
  pending.get(key)?.kill();
  pending.delete(key);
  analyses.delete(key);
}

function clearRelated(key) {
  const previous = relatedFiles.get(key) || [];
  relatedFiles.delete(key);
  for (const { uri } of previous) refreshRelated(uri);
}

function refreshRelated(uri) {
  const items = [];
  for (const files of relatedFiles.values()) {
    for (const file of files) {
      if (file.uri.toString() === uri.toString()) items.push(...file.items);
    }
  }
  if (items.length) relatedDiagnostics.set(uri, items);
  else relatedDiagnostics.delete(uri);
}

// The file a diagnostic or a related place names. SPIT gives it relative to
// the checked pipeline's folder (a recipe's folder, for a recipe), and the
// checked file itself by its own name there, so every `file` resolves the same
// way; one without a `file` is in the checked document.
function resolveFile(document, file) {
  if (!file) return document.uri.fsPath;
  return path.resolve(path.dirname(document.uri.fsPath), file);
}

// The lines of a file as `issue` reads them: the checked document, an open
// one with its unsaved text, or the file on disk.
function linesOf(document, file) {
  if (file === path.resolve(document.uri.fsPath)) return document;
  const open = vscode.workspace.textDocuments.find(item => item.uri.scheme === 'file' && path.resolve(item.uri.fsPath) === file);
  if (open) return open;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = text.split(/\r?\n/);
  return {
    lineCount: lines.length,
    lineAt(index) { return { range: new vscode.Range(index, 0, index, lines[index].length) }; }
  };
}

// An item of SPIT's `diagnostics` as an editor diagnostic in the file its
// `file` names, with each `related` place, such as an `imported here` line,
// as related information.
function issueFor(document, item) {
  const file = path.resolve(resolveFile(document, item.file));
  const diagnostic = issue(linesOf(document, file), item.line, item.message, item.severity, item.column, item.end_column);
  const related = [];
  for (const place of item.related || []) {
    const placeFile = path.resolve(resolveFile(document, place.file));
    const range = issue(linesOf(document, placeFile), place.line, '', 'error', place.column, place.end_column).range;
    related.push(new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(placeFile), range), place.message));
  }
  if (related.length) diagnostic.relatedInformation = related;
  return { file, diagnostic };
}

// A check's diagnostics are not all in the checked document: an imported
// library's are in the library, and a recipe's pipeline's in the pipeline.
// Those go to a collection of their own, rebuilt from every check, so a
// file whose problems are gone loses its marks.
function publishIssues(document, items) {
  const key = document.uri.toString();
  clearRelated(key);
  const local = [];
  const external = new Map();
  const own = path.resolve(document.uri.fsPath);
  for (const item of items) {
    const { file, diagnostic } = issueFor(document, item);
    if (file === own) {
      local.push(diagnostic);
      continue;
    }
    const uri = vscode.Uri.file(file);
    const found = external.get(uri.toString()) || { uri, items: [] };
    found.items.push(diagnostic);
    external.set(uri.toString(), found);
  }
  diagnostics.set(document.uri, local);
  relatedFiles.set(key, [...external.values()]);
  for (const { uri } of external.values()) refreshRelated(uri);
}

// One label per line from `spit check`'s `paths`: `→ path`, or, for a step
// with several outputs, each product with its path.
function pathHintLabels(paths) {
  const byLine = new Map();
  for (const { product, line, path: shown } of paths) {
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push({ product, shown });
  }
  const labels = new Map();
  for (const [line, items] of byLine) {
    labels.set(line, items.length === 1
      ? `→ ${items[0].shown}`
      : items.map(item => `${item.product} → ${item.shown}`).join('  '));
  }
  return labels;
}

// Each path at the end of its step's line; a failed check shows none, since
// its lines may have moved.
function providePathHints(document, range) {
  const labels = shownPaths.get(document.uri.toString());
  if (!labels) return [];
  const hints = [];
  for (const [line, label] of labels) {
    const index = line - 1;
    if (index < range.start.line || index > range.end.line || index >= document.lineCount) continue;
    const hint = new vscode.InlayHint(document.lineAt(index).range.end, label);
    hint.paddingLeft = true;
    hints.push(hint);
  }
  return hints;
}

function showPaths(document, paths) {
  const key = document.uri.toString();
  if (paths) shownPaths.set(key, pathHintLabels(paths));
  else shownPaths.delete(key);
  pathHintsChanged.fire();
}

// `spit check` compiles a pipeline, checks a recipe against the pipeline
// its `pipeline` line names, or checks a .spitout's records.
function checkable(document) {
  return document.languageId === 'spit' && document.uri.scheme === 'file' && /\.spit(?:in|out)?$/i.test(document.uri.fsPath);
}

// What `spit check --hovers` says about each line: a pipeline's products
// and operations, from `hovers`, and SPIT's own words, from `words`, each
// pointing to its entry in `word_docs`. Columns become 0-based offsets.
function hoverItems(result) {
  const byLine = new Map();
  const add = (line, column, endColumn, item) => {
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push({ start: column - 1, end: endColumn - 1, ...item });
  };
  for (const hover of result.hovers || []) {
    add(hover.line, hover.column, hover.end_column, { code: hover.signature, details: hover.details });
  }
  const docs = result.word_docs || {};
  for (const word of result.words || []) {
    const doc = docs[word.word];
    if (doc) add(word.line, word.column, word.end_column, { code: doc.example, summary: doc.summary, reference: doc.reference });
  }
  return byLine;
}

// Compiler details are plain text. Keep prose escaped, and only turn the
// known code-bearing fields into code blocks.
function appendHoverDetail(contents, detail) {
  const body = /^(Carried out by the steps in its body|This call expands to): ([\s\S]+)$/.exec(detail);
  if (body) {
    contents.appendText(`${body[1]}:`).appendMarkdown('\n\n');
    contents.appendCodeblock(body[2], 'spit');
    return;
  }
  const labelledCode = /^(Used by|Command|Verify|Type bindings|Stage): (.+)$/.exec(detail);
  if (labelledCode) {
    const [, label, value] = labelledCode;
    contents.appendText(`${label}:`).appendMarkdown('\n\n');
    contents.appendCodeblock(label === 'Used by' ? value.split('; ').join('\n') : value,
      label === 'Command' || label === 'Verify' ? 'sh' : 'spit');
    return;
  }
  if (detail.startsWith('Path template: ')) {
    const rest = detail.slice('Path template: '.length);
    const descriptionStart = rest.lastIndexOf(' (');
    if (descriptionStart !== -1 && rest.endsWith(').')) {
      contents.appendText('Path template:').appendMarkdown('\n\n');
      contents.appendCodeblock(rest.slice(0, descriptionStart), 'spit');
      contents.appendMarkdown('\n\n').appendText(rest.slice(descriptionStart + 1));
      return;
    }
  }
  const producer = /^Derived product\. Produced by (.+)\.$/.exec(detail);
  if (producer) {
    contents.appendText('Derived product. Produced by:').appendMarkdown('\n\n');
    contents.appendCodeblock(producer[1], 'spit');
    return;
  }
  const declared = /^Declared type: (.+?)\. (.+)$/.exec(detail);
  if (declared) {
    contents.appendText('Declared type:').appendMarkdown('\n\n');
    contents.appendCodeblock(declared[1], 'spit');
    contents.appendMarkdown('\n\n').appendText(declared[2]);
    return;
  }
  if (/^[^\n]+ [←→] [^\n]+$/.test(detail)) {
    contents.appendCodeblock(detail, 'spit');
    return;
  }
  contents.appendText(detail);
}

// The item under the pointer from the check of this version of the
// document, checking it now if the check is still to come.
async function provideHover(context, document, position, token) {
  if (!checkable(document) || vscode.workspace.isTrusted === false || token?.isCancellationRequested) return;
  const version = document.version;
  const key = document.uri.toString();
  const request = lint(context, document);
  const analysis = analyses.get(key);
  const items = await request;
  if (!items || analyses.get(key) !== analysis || token?.isCancellationRequested || document.isClosed || document.version !== version || vscode.workspace.isTrusted === false) return;
  const item = items.get(position.line + 1)?.find(item => item.start <= position.character && position.character < item.end);
  if (!item) return null;
  // SPIT's details are plain text; a word's summary marks code with backticks.
  const contents = new vscode.MarkdownString();
  contents.isTrusted = false;
  contents.supportHtml = false;
  contents.appendCodeblock(item.code, 'spit');
  if (item.summary) contents.appendMarkdown(`\n\n${item.summary}`);
  const details = item.details || [];
  for (let index = 0; index < details.length; index++) {
    const detail = details[index];
    contents.appendMarkdown('\n\n');
    // Keep the call's port/product mappings together as one readable block.
    // Each line is compiler plain text; code blocks escape embedded fences.
    if (/^[^\n]+ [←→] [^\n]+$/.test(detail)) {
      const bindings = [detail];
      while (/^[^\n]+ [←→] [^\n]+$/.test(details[index + 1] || '')) {
        bindings.push(details[++index]);
      }
      contents.appendCodeblock(bindings.join('\n'), 'spit');
      continue;
    }
    appendHoverDetail(contents, detail);
  }
  if (item.reference) contents.appendMarkdown(`\n\n[Language reference](${item.reference})`);
  return new vscode.Hover(contents, new vscode.Range(position.line, item.start, position.line, item.end));
}

function schedule(context, document, delay = 250) {
  if (!checkable(document) || vscode.workspace.isTrusted === false) return;
  const key = document.uri.toString();
  stop(document.uri);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    lint(context, document);
  }, delay));
}

function lint(context, document) {
  const key = document.uri.toString();
  const version = document.version;
  const executable = executablePath(context, document);
  let executableModified;
  try { executableModified = fs.statSync(executable).mtimeMs; } catch {}
  const existing = analyses.get(key);
  if (existing?.version === version && existing.executable === executable &&
      existing.executableModified === executableModified) return existing.promise;
  if (existing) stop(document.uri);
  clearTimeout(timers.get(key));
  timers.delete(key);
  let settle;
  const analysis = { version, executable, executableModified, promise: new Promise(resolve => { settle = resolve; }) };
  analyses.set(key, analysis);

  const args = ['check', document.uri.fsPath, '--json', '--stdin', '--hovers'];
  const child = spawn(executable, args, {
    cwd: path.dirname(document.uri.fsPath),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  pending.set(key, child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, CHECK_TIMEOUT_MS);
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.on('error', error => { errors += error.message; });
  child.on('close', code => {
    clearTimeout(timeout);
    let items = null;
    try {
      if (pending.get(key) !== child || analyses.get(key) !== analysis) return;
      pending.delete(key);
      if (document.isClosed || document.version !== version || vscode.workspace.isTrusted === false) {
        analyses.delete(key);
        return;
      }
      items = finishCheck(document, key, code, timedOut, output, errors);
    } finally {
      settle(items);
    }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(document.getText());
  return analysis.promise;
}

// Show what a finished check found, and return its hover items, or null.
function finishCheck(document, key, code, timedOut, output, errors) {
  if (timedOut) {
    showPaths(document, null);
    clearRelated(key);
    diagnostics.set(document.uri, [issue(document, null, `SPIT check did not finish within ${CHECK_TIMEOUT_MS / 1000} seconds and was stopped`)]);
    return null;
  }
  if (code !== 0 && code !== 1) {
    showPaths(document, null);
    clearRelated(key);
    diagnostics.set(document.uri, [issue(document, null, `SPIT check failed: ${errors.trim() || `exit ${code}`}`)]);
    return null;
  }
  try {
    const result = JSON.parse(output);
    if (!Array.isArray(result.diagnostics) || (code === 1 && !result.diagnostics.some(item => item.severity === 'error'))) {
      throw new Error('missing error diagnostics');
    }
    publishIssues(document, result.diagnostics);
    // Only a pipeline that checks clean has `paths`.
    showPaths(document, result.paths);
    return hoverItems(result);
  } catch (error) {
    showPaths(document, null);
    clearRelated(key);
    const message = code === 0
      ? `SPIT returned invalid diagnostics: ${error.message}`
      : `SPIT check failed: ${errors.trim() || `exit ${code}`} (invalid diagnostics: ${error.message})`;
    diagnostics.set(document.uri, [issue(document, null, message)]);
    return null;
  }
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('SPIT');
  context.subscriptions.push(diagnostics);
  relatedDiagnostics = vscode.languages.createDiagnosticCollection('SPIT other files');
  context.subscriptions.push(relatedDiagnostics);
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(
    { language: 'spit' },
    { provideDocumentSemanticTokens: provideSpitSemanticTokens },
    spitSemanticLegend
  ));
  context.subscriptions.push(vscode.languages.registerHoverProvider(
    { language: 'spit' },
    { provideHover: (document, position, token) => provideHover(context, document, position, token) }
  ));
  pathHintsChanged = new vscode.EventEmitter();
  context.subscriptions.push(pathHintsChanged, vscode.languages.registerInlayHintsProvider(
    { language: 'spit' },
    { onDidChangeInlayHints: pathHintsChanged.event, provideInlayHints: providePathHints }
  ));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => schedule(context, document, 0)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => schedule(context, event.document)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    stop(document.uri);
    shownPaths.delete(document.uri.toString());
    analyses.delete(document.uri.toString());
    diagnostics.delete(document.uri);
    clearRelated(document.uri.toString());
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('spit')) {
      for (const document of vscode.workspace.textDocuments) schedule(context, document, 0);
    }
  }));
  // Re-check when a pipeline changes on disk: another pipeline may import it,
  // and a recipe is checked against it.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.spit');
  const refresh = () => {
    for (const document of vscode.workspace.textDocuments) {
      schedule(context, document, 0);
    }
  };
  context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  for (const document of vscode.workspace.textDocuments) schedule(context, document, 0);
}

function deactivate() {
  for (const key of new Set([...pending.keys(), ...timers.keys(), ...analyses.keys()])) stop(vscode.Uri.parse(key));
  for (const key of relatedFiles.keys()) clearRelated(key);
}

// stripComment is exported for the tests that check it against SPIT's own,
// and pathHintLabels for the tests of the labels it makes.
module.exports = { activate, deactivate, stripComment, pathHintLabels };
