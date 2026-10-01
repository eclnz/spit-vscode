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

function publishIssues(document, items) {
  const key = document.uri.toString();
  clearRelated(key);
  const local = [];
  const external = new Map();
  for (const item of items) {
    const file = item.file && (path.isAbsolute(item.file)
      ? item.file
      : path.resolve(path.dirname(document.uri.fsPath), item.file));
    if (!file || path.resolve(file) === path.resolve(document.uri.fsPath)) {
      local.push(issue(document, item.line, item.message, item.severity, item.column, item.end_column));
      continue;
    }
    const uri = vscode.Uri.file(file);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    const lines = text.split(/\r?\n/);
    const target = {
      lineCount: lines.length,
      lineAt(index) { return { range: new vscode.Range(index, 0, index, lines[index].length) }; }
    };
    const found = external.get(uri.toString()) || { uri, items: [] };
    found.items.push(issue(target, item.line, item.message, item.severity, item.column, item.end_column));
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
    hint.tooltip = 'Where SPIT writes this output: its path rule, with its extension';
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

// `spit check` compiles a pipeline, or checks a recipe against the pipeline
// its `pipeline` line names; a .spitout has nothing to check on its own.
function checkable(document) {
  return document.languageId === 'spit' && document.uri.scheme === 'file' && /\.spit(?:in)?$/i.test(document.uri.fsPath);
}

function schedule(context, document, delay = 250) {
  if (!checkable(document)) return;
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
  const args = ['check', document.uri.fsPath, '--json', '--stdin'];

  const child = spawn(executablePath(context, document), args, {
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
    if (pending.get(key) !== child) return;
    pending.delete(key);
    if (document.isClosed || document.version !== version) return;
    if (timedOut) {
      showPaths(document, null);
      clearRelated(key);
      diagnostics.set(document.uri, [issue(document, null, `SPIT check did not finish within ${CHECK_TIMEOUT_MS / 1000} seconds and was stopped`)]);
      return;
    }
    if (code !== 0) {
      showPaths(document, null);
      clearRelated(key);
      diagnostics.set(document.uri, [issue(document, null, `SPIT check failed: ${errors.trim() || `exit ${code}`}`)]);
      return;
    }
    try {
      const result = JSON.parse(output);
      publishIssues(document, result.diagnostics);
      // Only a pipeline that checks clean has `paths`.
      showPaths(document, result.paths);
    } catch (error) {
      showPaths(document, null);
      clearRelated(key);
      diagnostics.set(document.uri, [issue(document, null, `SPIT returned invalid diagnostics: ${error.message}`)]);
    }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(document.getText());
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('SPIT');
  context.subscriptions.push(diagnostics);
  relatedDiagnostics = vscode.languages.createDiagnosticCollection('SPIT recipe pipelines');
  context.subscriptions.push(relatedDiagnostics);
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(
    { language: 'spit' },
    { provideDocumentSemanticTokens: provideSpitSemanticTokens },
    spitSemanticLegend
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
  const refresh = changed => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.toString() !== changed.toString()) schedule(context, document, 0);
    }
  };
  context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  for (const document of vscode.workspace.textDocuments) schedule(context, document, 0);
}

function deactivate() {
  for (const key of pending.keys()) stop(vscode.Uri.parse(key));
  for (const key of relatedFiles.keys()) clearRelated(key);
}

// stripComment is exported for the tests that check it against SPIT's own,
// and pathHintLabels for the tests of the labels it makes.
module.exports = { activate, deactivate, stripComment, pathHintLabels };
