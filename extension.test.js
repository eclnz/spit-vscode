const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const binary = process.env.SPIT_TEST_EXECUTABLE || path.resolve(__dirname, '..', 'spit', 'target', 'debug', process.platform === 'win32' ? 'spit.exe' : 'spit');

test('checks unsaved edits and clears fixed errors', { skip: !fs.existsSync(binary) }, async () => {
  let onChange;
  const results = new Map();
  const document = fakeDocument(path.join(__dirname, 'unsaved.spit'), 'source raw [id]\noperation copy(one)\nresult = copy(raw)\nlater = copy(raw)\n');
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));

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

  // Rules about a dataset belong in its recipe, not the pipeline.
  document.text = 'source raw [id]\nrequire raw count>=1 per [id]\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.some(item => /belong in/.test(item.message)));
  assert.equal(results.get(document.uri.toString()).length, 1);
  assert.deepEqual(span(results.get(document.uri.toString())[0]), [1, 0, 29]);
  assert.match(results.get(document.uri.toString())[0].message, /belong in a \.spitin recipe/);
  extension.deactivate();
});

test('checks a recipe against the pipeline it names', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-'));
  fs.writeFileSync(path.join(folder, 'analysis.spit'), 'source raw [id]\noperation copy(one)\nresult = copy(raw)\n');
  let onChange;
  const results = new Map();
  const document = fakeDocument(path.join(folder, 'cohort.spitin'), 'pipeline analysis.spit\nrequire raw count>=1 per [id]\n');
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.get(document.uri.toString())?.length === 0);

    document.text = 'pipeline analysis.spit\nrequire raw count>=1 per [id]\nrequire rwa count>=1 per [id]\n';
    document.version++;
    onChange({ document });
    await until(() => results.get(document.uri.toString())?.length === 1);
    const [error] = results.get(document.uri.toString());
    assert.equal(error.range.start.line, 2);
    assert.match(error.message, /rwa/);
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('places a recipe check\'s pipeline error on the pipeline file', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-pipeline-'));
  const pipeline = path.join(folder, 'analysis.spit');
  fs.writeFileSync(pipeline, 'source raw [id]\noperation copy(one)\nresult = copy(rwa)\n');
  const results = new Map();
  let onChange;
  const document = fakeDocument(path.join(folder, 'data.spitin'), 'pipeline analysis.spit\n');
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.get(`file://${pipeline}`)?.length === 1);
    assert.deepEqual(span(results.get(`file://${pipeline}`)[0]), [2, 14, 17]);
    assert.match(results.get(`file://${pipeline}`)[0].message, /unknown product `rwa`/);
    assert.deepEqual(results.get(document.uri.toString()), []);

    fs.writeFileSync(pipeline, 'source raw [id]\noperation copy(one)\nresult = copy(raw)\n');
    document.version++;
    onChange({ document });
    await until(() => results.get(document.uri.toString())?.length === 0 && !results.has(`file://${pipeline}`));
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('leaves a .spitout unchecked, since check reads no data', () => {
  const results = new Map();
  const document = fakeDocument(path.join(__dirname, 'inputs.spitout'), 'sources:\n    raw[id=1]\n');
  const extension = load(mockVscode(document, results, () => {}));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  assert.equal(results.size, 0);
  extension.deactivate();
});

function fakeDocument(fsPath, text) {
  return {
    uri: { scheme: 'file', fsPath, toString() { return `file://${this.fsPath}`; } },
    languageId: 'spit',
    version: 1,
    isClosed: false,
    text,
    getText() { return this.text; },
    get lineCount() { return this.text.split('\n').length; },
    lineAt(index) {
      return { range: new Range(index, 0, index, this.text.split('\n')[index].length) };
    }
  };
}

function mockVscode(document, results, onChange) {
  const disposable = { dispose() {} };
  return {
    Uri: { file(fsPath) { return { fsPath, toString() { return `file://${this.fsPath}`; } }; } },
    Range,
    Diagnostic: class {
      constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
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
      onDidChangeTextDocument(callback) { onChange(callback); return disposable; },
      onDidCloseTextDocument() { return disposable; },
      onDidChangeConfiguration() { return disposable; },
      createFileSystemWatcher() {
        return { ...disposable, onDidChange() { return disposable; }, onDidCreate() { return disposable; }, onDidDelete() { return disposable; } };
      }
    }
  };
}

// Load the extension against a `vscode` mock, fresh for each test.
// SPIT's repository, beside this one as for the binary above. Its fixture
// holds the comment stripping SPIT does, which highlighting must match.
const spitRepository = process.env.SPIT_REPOSITORY || path.resolve(__dirname, '..', 'spit');
const commentFixture = path.join(spitRepository, 'tests', 'fixtures', 'comments.txt');

test('strips comments as SPIT does', { skip: !fs.existsSync(commentFixture) }, () => {
  const { stripComment } = load({ SemanticTokensLegend: class {} });
  const lines = fs.readFileSync(commentFixture, 'utf8').split('\n').filter(line => !line.startsWith('#'));
  let cases = 0;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    assert.ok(lines[index].startsWith('in:') && lines[index + 1].startsWith('out:'), lines[index]);
    const input = lines[index].slice('in:'.length);
    assert.equal(stripComment(input), lines[index + 1].slice('out:'.length), JSON.stringify(input));
    cases++;
  }
  assert.ok(cases > 10);
});

function load(vscode) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('./extension');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('./extension')];
  }
}

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
    'contexts sessions:',
    '    [site=A,device=D1]',
    'discover sessions: [site, device] from dirs data/site-{site}/device-{device}',
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
  assert.equal(at(18, 'sessions').tokenModifiers, 1);
  assert.equal(at(18, 'site').tokenType, typeIndex('parameter'));

  // A .spitout holds records alone, and is colored the same way.
  const records = ['contexts:', '    [site=A]', 'sources:', '    reading[site=A,device=D1]: data/A/D1.csv'];
  const recordTokens = registered.provideDocumentSemanticTokens({
    getText() { return records.join('\n'); },
    lineCount: records.length,
    lineAt(index) { return { text: records[index] }; }
  });
  const record = (line, needle) => recordTokens.find(t => t.line === line && records[line].slice(t.char, t.char + t.length) === needle);
  assert.equal(record(1, 'site').tokenType, typeIndex('parameter'));
  assert.equal(record(3, 'reading').tokenType, typeIndex('variable'));
  assert.equal(record(3, 'D1').tokenType, typeIndex('enumMember'));
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
  // The executable is the only setting: `spit check` needs no other file.
  assert.deepEqual(Object.keys(manifest.contributes.configuration.properties), ['spit.executablePath']);
  assert.equal(manifest.contributes.configuration.properties['spit.executablePath'].scope, 'machine-overridable');
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});
