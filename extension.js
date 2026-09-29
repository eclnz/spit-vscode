const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECK_TIMEOUT_MS = 15000;

const pending = new Map();
const timers = new Map();
let diagnostics;

// Semantic highlighting: colors names by what they *are* in this document
// (a declared product, a declared operation, a dimension, ...) rather than
// by shape alone, which a TextMate grammar cannot know. Sectioned documents
// only (products:/operations:/pipeline:/constraints:/commands:); the older
// flow style (`source name`, `operation name(...)`, `output = op(...)`) is
// still colored by the TextMate grammar's regex rules.
const SEMANTIC_TOKEN_TYPES = ['variable', 'function', 'type', 'parameter', 'enumMember'];
const SEMANTIC_TOKEN_MODIFIERS = ['declaration'];
const DECLARATION = 1;
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
    wordStart = quote === null && /\s/.test(character);
  }
  return line;
}

function isSectionedDocument(lines) {
  return lines.some(line => {
    const trimmed = stripComment(line).trim();
    return trimmed === 'products:' || trimmed === 'operations:' || trimmed === 'pipeline:' ||
      trimmed === 'constraints:' || trimmed === 'commands:';
  });
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

function findMatchingParen(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function trimmedRange(text) {
  const start = text.length - text.trimStart().length;
  return { value: text.trim(), start };
}

function pushIdentifiers(text, base, type, push) {
  const pattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match;
  while ((match = pattern.exec(text))) push(base + match.index, match[0].length, type);
}

// Type names are always capitalized in SPIT (including single-letter
// generics like `S`), so a plain regex reliably picks them out of a
// signature or product declaration without a real type-expression parser.
function pushTypeTokens(text, base, push) {
  const pattern = /\b[A-Z][A-Za-z0-9_]*\b/g;
  let match;
  while ((match = pattern.exec(text))) push(base + match.index, match[0].length, 'type');
}

function handleProductLine(content, push) {
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(content);
  if (!nameMatch) return;
  push(0, nameMatch[0].length, 'variable', DECLARATION);
  let offset = nameMatch[0].length;
  let rest = content.slice(offset);
  let whitespace = /^\s*/.exec(rest)[0].length;
  offset += whitespace;
  rest = rest.slice(whitespace);
  if (rest.startsWith(':')) {
    offset += 1;
    rest = rest.slice(1);
    whitespace = /^\s*/.exec(rest)[0].length;
    offset += whitespace;
    rest = rest.slice(whitespace);
    const bracketIndex = rest.indexOf('[');
    const typeText = bracketIndex === -1 ? rest : rest.slice(0, bracketIndex);
    pushTypeTokens(typeText, offset, push);
    offset += typeText.length;
    rest = rest.slice(typeText.length);
  }
  const bracketStart = rest.indexOf('[');
  const bracketEnd = bracketStart === -1 ? -1 : rest.indexOf(']', bracketStart);
  if (bracketStart !== -1 && bracketEnd !== -1) {
    pushIdentifiers(rest.slice(bracketStart + 1, bracketEnd), offset + bracketStart + 1, 'parameter', push);
  }
}

function handleOperationLine(content, push) {
  let offset = 0;
  let rest = content;
  const leading = /^operation\s+/.exec(rest);
  if (leading) {
    offset += leading[0].length;
    rest = rest.slice(leading[0].length);
  }
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if (!nameMatch) return;
  push(offset, nameMatch[0].length, 'function', DECLARATION);
  offset += nameMatch[0].length;
  rest = rest.slice(nameMatch[0].length);
  const parenIndex = rest.indexOf('(');
  if (parenIndex === -1) return;
  const closeIndex = findMatchingParen(rest, parenIndex);
  if (closeIndex === -1) return;
  const argsBase = offset + parenIndex + 1;
  const argsText = rest.slice(parenIndex + 1, closeIndex);
  for (const item of splitTopLevel(argsText, ',')) {
    let itemRest = item.text;
    let itemOffset = item.start;
    const portMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)/.exec(itemRest);
    if (portMatch && portMatch[1] !== 'many' && portMatch[1] !== 'one') {
      const nameOffset = /^\s*/.exec(itemRest)[0].length;
      push(argsBase + itemOffset + nameOffset, portMatch[1].length, 'parameter');
      itemOffset += portMatch[0].length;
      itemRest = itemRest.slice(portMatch[0].length);
    }
    const cardinalityMatch = /^\s*(many|one)\s+/.exec(itemRest);
    if (cardinalityMatch) {
      itemOffset += cardinalityMatch[0].length;
      itemRest = itemRest.slice(cardinalityMatch[0].length);
    }
    pushTypeTokens(itemRest, argsBase + itemOffset, push);
  }
  offset += closeIndex + 1;
  rest = rest.slice(closeIndex + 1);
  const clauses = splitTopLevel(rest, '@');
  const outputText = clauses[0].text;
  const arrowMatch = /->\s*/.exec(outputText);
  if (arrowMatch) {
    const afterArrow = outputText.slice(arrowMatch.index + arrowMatch[0].length);
    const afterArrowOffset = offset + arrowMatch.index + arrowMatch[0].length;
    const namedPorts = /^\s*\(/.exec(afterArrow);
    if (namedPorts) {
      const openIndex = afterArrow.indexOf('(');
      const closeIndex2 = findMatchingParen(afterArrow, openIndex);
      if (closeIndex2 !== -1) {
        const portsBase = afterArrowOffset + openIndex + 1;
        const portsText = afterArrow.slice(openIndex + 1, closeIndex2);
        for (const item of splitTopLevel(portsText, ',')) {
          let itemRest = item.text;
          let itemOffset = item.start;
          const portMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(itemRest);
          if (portMatch) {
            const nameOffset = /^\s*/.exec(itemRest)[0].length;
            push(portsBase + itemOffset + nameOffset, portMatch[1].length, 'parameter');
            itemOffset += portMatch[0].length;
            itemRest = itemRest.slice(portMatch[0].length);
          }
          pushTypeTokens(itemRest, portsBase + itemOffset, push);
        }
      }
    } else {
      pushTypeTokens(afterArrow, afterArrowOffset, push);
    }
  }
  for (let index = 1; index < clauses.length; index++) {
    const clauseBase = offset + clauses[index].start;
    const clauseMatch = /^\s*(drop)\s*\(([^)]*)\)/.exec(clauses[index].text);
    if (!clauseMatch) continue;
    const dimension = trimmedRange(clauseMatch[2]);
    const openIndex = clauseMatch[0].indexOf('(');
    push(clauseBase + openIndex + 1 + dimension.start, dimension.value.length, 'parameter');
  }
}

function handlePipelineLine(content, push) {
  const equalsIndex = content.indexOf('=');
  if (equalsIndex === -1) return;
  for (const item of splitTopLevel(content.slice(0, equalsIndex), ',')) {
    const nameMatch = /[A-Za-z_][A-Za-z0-9_]*/.exec(item.text);
    if (nameMatch) push(item.start + nameMatch.index, nameMatch[0].length, 'variable');
  }
  const callOffset = equalsIndex + 1;
  const call = content.slice(callOffset);
  const opMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(call);
  if (!opMatch) return;
  const nameOffset = /^\s*/.exec(call)[0].length;
  push(callOffset + nameOffset, opMatch[1].length, 'function');
  const parenIndex = call.indexOf('(', nameOffset);
  const closeIndex = findMatchingParen(call, parenIndex);
  if (closeIndex === -1) return;
  const argsBase = callOffset + parenIndex + 1;
  const argsText = call.slice(parenIndex + 1, closeIndex);
  for (const item of splitTopLevel(argsText, ',')) {
    const selectorSplit = splitTopLevel(item.text, '@');
    const productMatch = /[A-Za-z_][A-Za-z0-9_]*/.exec(selectorSplit[0].text);
    if (productMatch) push(argsBase + item.start + productMatch.index, productMatch[0].length, 'variable');
    for (let index = 1; index < selectorSplit.length; index++) {
      const clauseBase = argsBase + item.start + selectorSplit[index].start;
      const clauseMatch = /^\s*(vary|where|same|each)\s*\(([^)]*)\)/.exec(selectorSplit[index].text);
      if (!clauseMatch) continue;
      const innerBase = clauseBase + clauseMatch[0].indexOf('(') + 1;
      if (clauseMatch[1] === 'where') {
        for (const pair of splitTopLevel(clauseMatch[2], ',')) {
          const eqIndex = pair.text.indexOf('=');
          if (eqIndex === -1) continue;
          const dimension = trimmedRange(pair.text.slice(0, eqIndex));
          push(innerBase + pair.start + dimension.start, dimension.value.length, 'parameter');
          const value = trimmedRange(pair.text.slice(eqIndex + 1));
          push(innerBase + pair.start + eqIndex + 1 + value.start, value.value.length, 'enumMember');
        }
      } else {
        pushIdentifiers(clauseMatch[2], innerBase, 'parameter', push);
      }
    }
  }
}

function handleConstraintLine(content, push) {
  const leading = /^(?:require|skip)\s+/.exec(content);
  if (!leading) return;
  const subjectStart = leading[0].length;
  const perIndex = content.indexOf(' per ');
  if (perIndex === -1) return;
  const subject = content.slice(subjectStart, perIndex);
  const tokenPattern = /\S+/g;
  let match;
  let first = true;
  while ((match = tokenPattern.exec(subject))) {
    const tokenBase = subjectStart + match.index;
    if (first) {
      push(tokenBase, match[0].length, 'variable');
      first = false;
      continue;
    }
    if (/^count(=|>=)\d+$/.test(match[0])) continue;
    const eqIndex = match[0].indexOf('=');
    if (eqIndex === -1) continue;
    push(tokenBase, eqIndex, 'parameter');
    let valueOffset = eqIndex + 1;
    for (const value of match[0].slice(eqIndex + 1).split(',')) {
      if (value.length) push(tokenBase + valueOffset, value.length, 'enumMember');
      valueOffset += value.length + 1;
    }
  }
  const after = content.slice(perIndex + 5);
  const afterBase = perIndex + 5;
  const bracketStart = after.indexOf('[');
  const bracketEnd = bracketStart === -1 ? -1 : after.indexOf(']', bracketStart);
  if (bracketStart !== -1 && bracketEnd !== -1) {
    pushIdentifiers(after.slice(bracketStart + 1, bracketEnd), afterBase + bracketStart + 1, 'parameter', push);
  }
}

function handleCommandLine(content, push) {
  let rest = content;
  let offset = 0;
  const verify = /^verify\s+/.exec(rest);
  if (verify) {
    offset += verify[0].length;
    rest = rest.slice(verify[0].length);
  }
  const colonIndex = rest.indexOf(':');
  const equalsIndex = rest.indexOf('=');
  const candidates = [colonIndex, equalsIndex].filter(index => index !== -1);
  if (candidates.length === 0) return;
  const delimiter = Math.min(...candidates);
  const name = trimmedRange(rest.slice(0, delimiter));
  if (name.value) push(offset + name.start, name.value.length, 'function');
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

function handleDiscoverLine(content, push) {
  const declaration = /^discover\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[([^\]]*)\]\s+from\s+dirs\s+/.exec(content);
  if (!declaration) return;
  const nameStart = content.indexOf(declaration[1], 'discover'.length);
  push(nameStart, declaration[1].length, 'variable', DECLARATION);
  const bracketStart = content.indexOf('[', nameStart + declaration[1].length);
  pushIdentifiers(declaration[2], bracketStart + 1, 'parameter', push);
  const pattern = content.slice(declaration[0].length);
  const placeholder = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let match;
  while ((match = placeholder.exec(pattern))) {
    push(declaration[0].length + match.index + 1, match[1].length, 'parameter');
  }
}

function provideSpitSemanticTokens(document) {
  const builder = new vscode.SemanticTokensBuilder(spitSemanticLegend);
  try {
    const lineCount = document.lineCount;
    const rawLines = [];
    for (let index = 0; index < lineCount; index++) rawLines.push(document.lineAt(index).text);
    if (isSectionedDocument(rawLines)) {
      let section = null;
      for (let index = 0; index < lineCount; index++) {
        try {
          const code = stripComment(rawLines[index]);
          const indent = /^\s*/.exec(code)[0].length;
          const content = code.slice(indent).trimEnd();
          if (content === '') continue;
          const header = /^(products|operations|pipeline|constraints|commands|sources|contexts):$/.exec(content);
          if (header) {
            section = header[1];
            continue;
          }
          if (/^contexts\s+[A-Za-z_][A-Za-z0-9_]*:$/.test(content)) {
            section = 'contexts';
            continue;
          }
          const push = (start, length, type, modifiers = 0) => {
            if (length > 0 && start >= 0) {
              builder.push(index, indent + start, length, SEMANTIC_TOKEN_TYPES.indexOf(type), modifiers);
            }
          };
          if (content.startsWith('discover ')) {
            handleDiscoverLine(content, push);
            section = null;
            continue;
          }
          switch (section) {
            case 'products': handleProductLine(content, push); break;
            case 'operations': handleOperationLine(content, push); break;
            case 'pipeline': handlePipelineLine(content, push); break;
            case 'constraints': handleConstraintLine(content, push); break;
            case 'commands': handleCommandLine(content, push); break;
            case 'sources': handleInventoryLine(content, push, true); break;
            case 'contexts': handleInventoryLine(content, push, false); break;
            default: break;
          }
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

function sourcesPath(document) {
  const configured = vscode.workspace.getConfiguration('spit', document.uri).get('sourcesFile').trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(document.uri.fsPath), configured);
  }
  if (/^\s*(?:sources|contexts(?:\s+[A-Za-z_][A-Za-z0-9_]*)?):\s*(?:#.*)?$/m.test(document.getText())) return undefined;
  const sibling = document.uri.fsPath.replace(/\.spit$/i, '.sources');
  return fs.existsSync(sibling) ? sibling : undefined;
}

function inputsPath(document) {
  const configured = (vscode.workspace.getConfiguration('spit', document.uri).get('inputsFile') || '').trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(document.uri.fsPath), configured);
  }
  const sibling = document.uri.fsPath.replace(/\.spit$/i, '.spitin');
  return fs.existsSync(sibling) ? sibling : undefined;
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

function schedule(context, document, delay = 250) {
  if (document.languageId !== 'spit' || document.uri.scheme !== 'file' || !/\.spit$/i.test(document.uri.fsPath)) return;
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
  const inputs = inputsPath(document);
  const source = inputs ? undefined : sourcesPath(document);
  const args = ['check', document.uri.fsPath, '--json', '--stdin'];
  if (inputs) args.push('--inputs', inputs);
  if (source) args.push('--sources', source);
  const configuredRoot = vscode.workspace.getConfiguration('spit', document.uri).get('rootDirectory').trim();
  if (!source && (configuredRoot || /^\s*discover\s+/m.test(document.getText()))) {
    const root = configuredRoot
      ? (path.isAbsolute(configuredRoot) ? configuredRoot : path.resolve(path.dirname(document.uri.fsPath), configuredRoot))
      : path.dirname(document.uri.fsPath);
    args.push('--root', root);
  }

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
      diagnostics.set(document.uri, [issue(document, null, `SPIT check did not finish within ${CHECK_TIMEOUT_MS / 1000} seconds and was stopped`)]);
      return;
    }
    if (code !== 0) {
      diagnostics.set(document.uri, [issue(document, null, `SPIT check failed: ${errors.trim() || `exit ${code}`}`)]);
      return;
    }
    try {
      const result = JSON.parse(output);
      diagnostics.set(document.uri, result.diagnostics.map(item => {
        // Only an external inventory's lines lie outside this document.
        const external = item.source === 'inventory' && source;
        const message = external ? `Inventory ${source}:${item.line}: ${item.message}` : item.message;
        return external
          ? issue(document, null, message, item.severity)
          : issue(document, item.line, message, item.severity, item.column, item.end_column);
      }));
    } catch (error) {
      diagnostics.set(document.uri, [issue(document, null, `SPIT returned invalid diagnostics: ${error.message}`)]);
    }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(document.getText());
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('SPIT');
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(
    { language: 'spit' },
    { provideDocumentSemanticTokens: provideSpitSemanticTokens },
    spitSemanticLegend
  ));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => schedule(context, document, 0)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => schedule(context, event.document)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    stop(document.uri);
    diagnostics.delete(document.uri);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('spit')) {
      for (const document of vscode.workspace.textDocuments) schedule(context, document, 0);
    }
  }));
  // Re-check when an inventory or an imported pipeline changes.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sources,spit,spitin}');
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
}

module.exports = { activate, deactivate };
