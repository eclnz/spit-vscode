const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pending = new Map();
const timers = new Map();
let diagnostics;

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
  if (/^\s*(sources|contexts):\s*(?:#.*)?$/m.test(document.getText())) return undefined;
  const sibling = document.uri.fsPath.replace(/\.spit$/i, '.sources');
  return fs.existsSync(sibling) ? sibling : undefined;
}

function issue(document, line, message) {
  const index = Number.isInteger(line) ? Math.max(0, Math.min(line - 1, document.lineCount - 1)) : 0;
  const range = document.lineAt(index).range;
  const item = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
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
  if (document.languageId !== 'spit' || document.uri.scheme !== 'file') return;
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
  const source = sourcesPath(document);
  const args = ['diagnose', document.uri.fsPath];
  if (source) args.push('--sources', source);

  const child = spawn(executablePath(context, document), args, {
    cwd: path.dirname(document.uri.fsPath),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  pending.set(key, child);
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.on('error', error => { errors += error.message; });
  child.on('close', code => {
    if (pending.get(key) !== child) return;
    pending.delete(key);
    if (document.isClosed || document.version !== version) return;
    if (code !== 0) {
      diagnostics.set(document.uri, [issue(document, null, `SPIT check failed: ${errors.trim() || `exit ${code}`}`)]);
      return;
    }
    try {
      const result = JSON.parse(output);
      diagnostics.set(document.uri, result.diagnostics.map(item => {
        const message = item.source === 'inventory'
          ? `Inventory ${source}:${item.line}: ${item.message}`
          : item.message;
        return issue(document, item.source === 'inventory' ? null : item.line, message);
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
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.sources');
  const refresh = () => {
    for (const document of vscode.workspace.textDocuments) schedule(context, document, 0);
  };
  context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  for (const document of vscode.workspace.textDocuments) schedule(context, document, 0);
}

function deactivate() {
  for (const key of pending.keys()) stop(vscode.Uri.parse(key));
}

module.exports = { activate, deactivate };
