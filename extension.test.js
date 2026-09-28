const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const binary = process.env.SPIT_TEST_EXECUTABLE || path.resolve(__dirname, '..', 'spit', 'target', 'debug', process.platform === 'win32' ? 'spit.exe' : 'spit');

test('checks unsaved edits and clears fixed errors', { skip: !fs.existsSync(binary) }, async () => {
  let onChange;
  const results = new Map();
  const disposable = { dispose() {} };
  const document = {
    uri: { scheme: 'file', fsPath: path.join(__dirname, 'unsaved.spit'), toString() { return `file://${this.fsPath}`; } },
    languageId: 'spit',
    version: 1,
    isClosed: false,
    text: 'source raw [id]\noperation copy(one)\nresult = copy(raw)\nlater = copy(raw)\n',
    getText() { return this.text; },
    get lineCount() { return this.text.split('\n').length; },
    lineAt(index) {
      return { range: new Range(index, 0, index, this.text.split('\n')[index].length) };
    }
  };
  const vscode = {
    Range,
    Diagnostic: class {
      constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    // The extension builds its semantic token legend when it loads.
    SemanticTokensLegend: class {},
    SemanticTokensBuilder: class {},
    languages: {
      createDiagnosticCollection() {
        return {
          set(uri, items) { results.set(uri.toString(), items); },
          delete(uri) { results.delete(uri.toString()); },
          dispose() {}
        };
      },
      registerDocumentSemanticTokensProvider() { return disposable; }
    },
    workspace: {
      textDocuments: [document],
      getConfiguration() { return { get(key) { return key === 'executablePath' ? binary : ''; } }; },
      onDidOpenTextDocument() { return disposable; },
      onDidChangeTextDocument(callback) { onChange = callback; return disposable; },
      onDidCloseTextDocument() { return disposable; },
      onDidChangeConfiguration() { return disposable; },
      createFileSystemWatcher() {
        return { ...disposable, onDidChange() { return disposable; }, onDidCreate() { return disposable; }, onDidDelete() { return disposable; } };
      }
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    extension = require('./extension');
  } finally {
    Module._load = originalLoad;
    // Each test loads the extension against its own `vscode` mock.
    delete require.cache[require.resolve('./extension')];
  }

  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  await until(() => results.get(document.uri.toString())?.length === 0);
  document.text = 'source raw [id]\noperation copy(one)\nresult copy(raw)\nlater = copy(raw\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.length === 2);
  // A missing `=` has no narrower token, so it marks the line's content; an
  // unclosed `(` is marked from the opener to the end of the line.
  assert.deepEqual(results.get(document.uri.toString()).map(item => span(item)), [
    [2, 0, 16],
    [3, 12, 16]
  ]);
  assert.match(results.get(document.uri.toString())[0].message, /expected `=`/);
  assert.match(results.get(document.uri.toString())[1].message, /expected closing `\)`/);

  document.text = document.text.replace('result copy(raw)', 'result = copy(raw)');
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.length === 1);
  assert.equal(results.get(document.uri.toString())[0].range.start.line, 3);

  document.text = 'source raw [id]\noperation copy(one)\nresult = copy(raw)\nlater = copy(raw)\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.length === 0);

  document.text = 'source raw [id]\nsource spare [id]\noperation copy(one)\nresult = copy(raw)\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.length === 1);
  const [warning] = results.get(document.uri.toString());
  // The warning marks only the unused name, `spare`.
  assert.deepEqual(span(warning), [1, 7, 12]);
  assert.equal(warning.severity, 1);
  assert.match(warning.message, /never used/);
  extension.deactivate();
});

test('highlights declared products, operations, and dimensions by role', () => {
  const vscode = {
    Range,
    SemanticTokensLegend: class {
      constructor(tokenTypes, tokenModifiers) { Object.assign(this, { tokenTypes, tokenModifiers }); }
    },
    SemanticTokensBuilder: class {
      constructor() { this.entries = []; }
      push(line, char, length, tokenType, tokenModifiers) { this.entries.push({ line, char, length, tokenType, tokenModifiers }); }
      build() { return this.entries; }
    },
    languages: {
      createDiagnosticCollection() { return { set() {}, delete() {}, dispose() {} }; },
      registerDocumentSemanticTokensProvider(_selector, provider) { return { dispose() {}, provider }; }
    },
    workspace: {
      textDocuments: [],
      getConfiguration() { return { get() { return ''; } }; },
      onDidOpenTextDocument() { return { dispose() {} }; },
      onDidChangeTextDocument() { return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      onDidChangeConfiguration() { return { dispose() {} }; },
      createFileSystemWatcher() {
        const disposable = { dispose() {} };
        return { ...disposable, onDidChange() { return disposable; }, onDidCreate() { return disposable; }, onDidDelete() { return disposable; } };
      }
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  let registered;
  try {
    extension = require('./extension');
    const subscriptions = [];
    extension.activate({ extensionPath: __dirname, subscriptions });
    registered = subscriptions.find(item => item.provider)?.provider;
  } finally {
    Module._load = originalLoad;
  }
  assert.ok(registered, 'semantic tokens provider was registered');

  const text = [
    'products:',
    '    reading : Reading<Raw> [site, device]',
    '    gain    [site, device]',
    '',
    'operations:',
    '    normalize(Reading<Raw>, one Gain) -> Reading<Normalized>',
    '',
    'pipeline:',
    '    normalized = normalize(reading @ vary(device), gain @ each(site))',
    '',
    'constraints:',
    '    require reading count>=1 per [site, device]',
    '',
    'sources:',
    '    reading[site=A,device=D1]',
    '',
    'contexts:',
    '    [site=A,device=D1]',
    ''
  ].join('\n');
  const lines = text.split('\n');
  const document = {
    getText() { return text; },
    lineCount: lines.length,
    lineAt(index) { return { text: lines[index] }; }
  };

  const tokens = registered.provideDocumentSemanticTokens(document);
  const at = (line, needle) => tokens.find(t => t.line === line && lines[line].slice(t.char, t.char + t.length) === needle);
  const typeIndex = name => vscode_types().indexOf(name);
  function vscode_types() { return ['variable', 'function', 'type', 'parameter', 'enumMember']; }

  const readingDecl = at(1, 'reading');
  assert.ok(readingDecl, 'declares the `reading` product');
  assert.equal(readingDecl.tokenType, typeIndex('variable'));
  assert.equal(readingDecl.tokenModifiers, 1, 'declaration modifier set');

  assert.equal(at(1, 'Reading').tokenType, typeIndex('type'));
  assert.equal(at(1, 'site').tokenType, typeIndex('parameter'));

  const normalizeDecl = at(5, 'normalize');
  assert.equal(normalizeDecl.tokenType, typeIndex('function'));
  assert.equal(normalizeDecl.tokenModifiers, 1);

  const normalizeCall = at(8, 'normalize');
  assert.equal(normalizeCall.tokenType, typeIndex('function'));
  assert.equal(normalizeCall.tokenModifiers, 0, 'a call site is not a declaration');

  assert.equal(at(8, 'device').tokenType, typeIndex('parameter'));
  assert.equal(at(8, 'site').tokenType, typeIndex('parameter'), 'an `each` dimension is a parameter');
  assert.equal(at(11, 'reading').tokenType, typeIndex('variable'));
  assert.equal(at(14, 'D1').tokenType, typeIndex('enumMember'));
  assert.equal(at(17, 'site').tokenType, typeIndex('parameter'));
  extension.deactivate();
});

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

// A single-line diagnostic's line and character span.
function span(item) {
  assert.equal(item.range.start.line, item.range.end.line);
  return [item.range.start.line, item.range.start.character, item.range.end.character];
}

async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for diagnostics');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a workspace cannot choose the executable, and untrusted folders are not checked', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['spit.executablePath'].scope, 'machine-overridable');
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});
