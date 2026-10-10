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
  const document = fakeDocument(path.join(__dirname, 'unsaved.spit'), 'source raw [id]\noperation copy(input)\nresult = copy(raw)\nlater = copy(raw)\n');
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));

  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  await until(() => results.get(document.uri.toString())?.length === 0);
  document.text = 'source raw [id]\noperation copy(input)\nresult copy(raw)\nlater = copy(raw\n';
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

  document.text = 'source raw [id]\noperation copy(input)\nresult = copy(raw)\nlater = copy(raw)\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.length === 0);

  document.text = 'source raw [id]\nsource spare [id]\noperation copy(input)\nresult = copy(raw)\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.length === 1);
  const [warning] = results.get(document.uri.toString());
  // The warning marks only the unused name, `spare`.
  assert.deepEqual(span(warning), [1, 7, 12]);
  assert.equal(warning.severity, 1);
  assert.match(warning.message, /never used/);

  // Rules about a dataset belong in its recipe, not the pipeline.
  document.text = 'source raw [id]\nrequire [id] where raw count>=1\n';
  document.version++;
  onChange({ document });
  await until(() => results.get(document.uri.toString())?.some(item => /belong in/.test(item.message)));
  assert.equal(results.get(document.uri.toString()).length, 1);
  assert.deepEqual(span(results.get(document.uri.toString())[0]), [1, 0, 31]);
  assert.match(results.get(document.uri.toString())[0].message, /belong in a \.spitin recipe/);
  extension.deactivate();
});

test('reads JSON errors on exit 1 and reports failed processes without diagnostics', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-exit-'));
  const executable = path.join(folder, 'spit-stub');
  const mode = path.join(folder, 'mode');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
if (mode === 'json') {
  fs.writeSync(1, JSON.stringify({ diagnostics: [{ severity: 'error', source: 'pipeline', line: 1, column: 2, end_column: 5, message: 'bad type' }] }));
  process.exitCode = 1;
} else {
  fs.writeSync(2, 'compiler failed');
  if (mode === 'invalid') fs.writeSync(1, 'not JSON');
  process.exitCode = mode === 'invalid' ? 1 : 2;
}
`, { mode: 0o755 });
  fs.writeFileSync(mode, 'json');
  const direct = require('node:child_process').spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(direct.stdout, /bad type/);
  const document = fakeDocument(path.join(folder, 'bad.spit'), 'bad type\n');
  const results = new Map();
  let onChange;
  const vscode = mockVscode(document, results, callback => { onChange = callback; });
  vscode.workspace.getConfiguration = () => ({ get: () => executable });
  const extension = load(vscode);
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.has(document.uri.toString()));
    assert.equal(results.get(document.uri.toString())?.[0]?.message, 'bad type');
    assert.deepEqual(span(results.get(document.uri.toString())[0]), [0, 1, 4]);
    for (const expected of ['invalid', 'crash']) {
      fs.writeFileSync(mode, expected);
      document.version++;
      onChange({ document });
      await until(() => results.get(document.uri.toString())?.[0]?.message.includes('compiler failed'));
      assert.match(results.get(document.uri.toString())[0].message, /SPIT check failed/);
      results.clear();
    }
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('checks a recipe against the pipeline it names', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-'));
  fs.writeFileSync(path.join(folder, 'analysis.spit'), 'source raw [id]\noperation copy(input)\nresult = copy(raw)\npath raw: in/{id}.txt\n');
  let onChange;
  const results = new Map();
  const document = fakeDocument(path.join(folder, 'cohort.spitin'), 'pipeline analysis.spit\nroot .\nrequire [id] where raw count>=1\n');
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.get(document.uri.toString())?.length === 0);

    document.text = 'pipeline analysis.spit\nroot .\nrequire [id] where raw count>=1\nrequire [id] where rwa count>=1\n';
    document.version++;
    onChange({ document });
    await until(() => results.get(document.uri.toString())?.length === 1);
    const [error] = results.get(document.uri.toString());
    assert.equal(error.range.start.line, 3);
    assert.match(error.message, /rwa/);
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('places a recipe check\'s pipeline error on the pipeline file', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-pipeline-'));
  const pipeline = path.join(folder, 'analysis.spit');
  fs.writeFileSync(pipeline, 'source raw [id]\noperation copy(input)\nresult = copy(rwa)\npath raw: in/{id}.txt\n');
  const results = new Map();
  let onChange;
  const document = fakeDocument(path.join(folder, 'data.spitin'), 'pipeline analysis.spit\nroot .\n');
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.get(`file://${pipeline}`)?.length === 1);
    assert.deepEqual(span(results.get(`file://${pipeline}`)[0]), [2, 14, 17]);
    assert.match(results.get(`file://${pipeline}`)[0].message, /unknown product `rwa`/);
    assert.deepEqual(results.get(document.uri.toString()), []);

    fs.writeFileSync(pipeline, 'source raw [id]\noperation copy(input)\nresult = copy(raw)\npath raw: in/{id}.txt\n');
    document.version++;
    onChange({ document });
    await until(() => results.get(document.uri.toString())?.length === 0 && !results.has(`file://${pipeline}`));
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

const LIBRARY_OPERATIONS = 'operation cp(a: Lines) -> Lines\ncommand cp: cp {a} {@output}\n';

// Check `text` as a pipeline in a fresh folder holding `files`, and return
// the folder, what each file's collection holds, and a way to recheck.
async function checkImporting(files, text, ready) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-imports-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
  const results = new Map();
  let onChange;
  const document = fakeDocument(path.join(folder, 'pipeline.spit'), text);
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  const at = name => results.get(`file://${path.join(folder, name)}`);
  await until(() => ready(at));
  const recheck = async (newText, done) => {
    if (newText !== undefined) document.text = newText;
    document.version++;
    onChange({ document });
    await until(() => done(at));
  };
  return { folder, at, document, extension, recheck };
}

// Where a related place is: its file relative to the folder, and its span.
function place(folder, related) {
  return [path.relative(folder, related.location.uri.fsPath), ...span(related.location), related.message];
}

test('places an error in an imported library in the library, with its `use` line related', { skip: !fs.existsSync(binary) }, async () => {
  const cases = [
    ['a body that reads a missing product',
      `${LIBRARY_OPERATIONS}operation wrap(x: Lines) -> (out: Lines):\n    out = cp(x)\n    z = cp(nope)\n`,
      [4, 8, 16], /the body of `wrap` reads `nope`/],
    ['an undeclared operation',
      `${LIBRARY_OPERATIONS}operation wrap(x: Lines) -> (out: Lines):\n    out = missing(x)\n`,
      [3, 10, 20], /operation `missing` must be declared before `wrap`/],
    ['a bad placeholder',
      'operation cp(a: Lines) -> Lines\ncommand cp: cp {a} {@output} {oops\noperation wrap(x: Lines) -> Lines\n',
      [1, 12, 34], /unclosed `\{` in `\{oops`/]
  ];
  for (const [name, library, library_span, message] of cases) {
    const text = 'use wrap from libs/lib.spit\nsource raw : Lines [id]\nout = wrap(raw)\nfoo bar baz\n';
    const run = await checkImporting({ 'libs/lib.spit': library }, text, at => at('libs/lib.spit')?.length === 1 && at('pipeline.spit')?.length === 1);
    try {
      const [error] = run.at('libs/lib.spit');
      assert.deepEqual(span(error), library_span, name);
      assert.match(error.message, message, name);
      assert.equal(error.severity, 0, name);
      // The `use` line is the related place, in the checked file by its own name.
      assert.deepEqual(error.relatedInformation.map(item => place(run.folder, item)), [['pipeline.spit', 0, 0, 27, 'imported here']], name);
      // The pipeline's own error stays in the pipeline, at its own line.
      const [own] = run.at('pipeline.spit');
      assert.deepEqual(span(own), [3, 0, 3], name);
      assert.match(own.message, /`foo` does not start a statement/, name);
      assert.equal(own.relatedInformation, undefined, name);
    } finally {
      run.extension.deactivate();
      fs.rmSync(run.folder, { recursive: true, force: true });
    }
  }
});

test('a nested import names each `use` line, and a fixed library loses its marks', { skip: !fs.existsSync(binary) }, async () => {
  const broken = `${LIBRARY_OPERATIONS}operation wrap(x: Lines) -> (out: Lines):\n    out = cp(nope)\n`;
  const run = await checkImporting(
    { 'a/b/lib.spit': broken, 'a/mid.spit': '# the middle\nuse wrap from b/lib.spit\n' },
    'use wrap from a/mid.spit\n',
    at => at('a/b/lib.spit')?.length === 1);
  try {
    assert.deepEqual(run.at('pipeline.spit'), []);
    assert.equal(run.at('a/mid.spit'), undefined);
    const [error] = run.at('a/b/lib.spit');
    assert.deepEqual(span(error), [3, 10, 18]);
    assert.deepEqual(error.relatedInformation.map(item => place(run.folder, item)), [
      ['a/mid.spit', 1, 0, 24, 'imported here'],
      ['pipeline.spit', 0, 0, 24, 'imported here']
    ]);

    // Fixing the library, then recheck: its marks go.
    fs.writeFileSync(path.join(run.folder, 'a/b/lib.spit'), broken.replace('cp(nope)', 'cp(x)'));
    await run.recheck(undefined, at => at('a/b/lib.spit') === undefined);
    assert.deepEqual(run.at('pipeline.spit'), []);
  } finally {
    run.extension.deactivate();
    fs.rmSync(run.folder, { recursive: true, force: true });
  }
});

test('a library error and the pipeline\'s later error on the same line are each in their own file', { skip: !fs.existsSync(binary) }, async () => {
  const library = `${LIBRARY_OPERATIONS}operation wrap(x: Lines) -> (out: Lines):\n    out = cp(nope)\n`;
  const text = 'use wrap from libs/lib.spit\nsource raw : Lines [id]\nout = wrap(raw)\nfoo bar baz\n';
  const run = await checkImporting({ 'libs/lib.spit': library }, text, at => at('libs/lib.spit')?.length === 1 && at('pipeline.spit')?.length === 1);
  try {
    // Line 4 of the library and line 4 of the pipeline are different places.
    assert.equal(run.at('libs/lib.spit')[0].range.start.line, 3);
    assert.equal(run.at('pipeline.spit')[0].range.start.line, 3);
    assert.match(run.at('libs/lib.spit')[0].message, /the body of `wrap`/);
    assert.match(run.at('pipeline.spit')[0].message, /`foo` does not start a statement/);

    // Fixing the pipeline's own line leaves the library's mark, and removing
    // the import leaves none.
    await run.recheck(text.replace('foo bar baz\n', ''), at => at('pipeline.spit')?.length === 0);
    assert.equal(run.at('libs/lib.spit').length, 1);
    await run.recheck('source raw : Lines [id]\n', at => at('libs/lib.spit') === undefined);
  } finally {
    run.extension.deactivate();
    fs.rmSync(run.folder, { recursive: true, force: true });
  }
});

test('shows each output path with its groups resolved and labels written out', { skip: !fs.existsSync(binary) }, async () => {
  const hints = {};
  const document = fakeDocument(path.join(__dirname, 'labels.spit'), [
    'path: out/sub-{sub}[/ses-{ses}]/{@labels}_{@product}',
    'ext: .img',
    'source scan : Image [sub, ses]',
    'path scan: in/{sub}/{ses}.raw',
    'operation copy(input: Image) -> Image',
    'operation merge(inputs: many Image) -> Image',
    'copied = copy(scan)',
    'merged = merge(copied @ vary(ses))',
    ''
  ].join('\n'));
  const extension = load(mockVscode(document, new Map(), () => {}, hints));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  const shown = () => hints.provider.provideInlayHints(document, new Range(0, 0, document.lineCount, 0));
  await until(() => shown().length === 2);
  const [copied, merged] = shown();
  assert.equal(copied.label, '→ out/sub-{sub}/ses-{ses}/sub-{sub}_ses-{ses}_copied.img');
  assert.equal(merged.label, '→ out/sub-{sub}/sub-{sub}_merged.img');
  extension.deactivate();
});

test('shows custom entities for each shape and drops an empty optional group', { skip: !fs.existsSync(binary) }, async () => {
  const hints = {};
  const document = fakeDocument(path.join(__dirname, 'entities.spit'), [
    'entities: {key}_{value} separated "-" empty ""',
    'entities sub: subject',
    'path: out/[{@entities}_]{@product}.img',
    'source scan [sub, ses]',
    'path scan: in/{sub}/{ses}.raw',
    'operation copy(input)',
    'operation merge(inputs: many)',
    'copied = copy(scan)',
    'merged = merge(copied @ vary(ses))',
    'all = merge(merged @ vary(sub))',
    ''
  ].join('\n'));
  const extension = load(mockVscode(document, new Map(), () => {}, hints));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  try {
    const shown = () => hints.provider.provideInlayHints(document, new Range(0, 0, document.lineCount, 0));
    await until(() => shown().length === 3);
    assert.deepEqual(shown().map(hint => hint.label), [
      '→ out/subject_{sub}-ses_{ses}_copied.img',
      '→ out/subject_{sub}_merged.img',
      '→ out/all.img'
    ]);
  } finally {
    extension.deactivate();
  }
});

test('shows where each output is written at the end of its step', { skip: !fs.existsSync(binary) }, async () => {
  const hints = {};
  let changed = 0;
  const document = fakeDocument(path.join(__dirname, 'paths.spit'), [
    'path: out/{@product}/{@entities}',
    'ext: .img',
    'source raw : Image [id]',
    'path raw: in/{id}.raw',
    'operation copy(input: Image) -> Image',
    'operation align(input: Image) -> (matrix: Matrix .mat, log: Log .txt)',
    'copied = copy(raw)',
    'matrix, log = align(copied)',
    ''
  ].join('\n'));
  const extension = load(mockVscode(document, new Map(), () => {}, hints));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  const shown = () => hints.provider.provideInlayHints(document, new Range(0, 0, document.lineCount, 0));
  hints.provider.onDidChangeInlayHints(() => { changed++; });
  await until(() => shown().length === 2);
  assert.ok(changed > 0);
  const [copied, aligned] = shown();
  // At the end of each step's line, the source's own rule needing no hint.
  assert.deepEqual([copied.position.line, copied.position.character], [6, 18]);
  assert.equal(copied.label, '→ out/copied/{@entities}.img');
  assert.equal(aligned.position.line, 7);
  assert.equal(aligned.label, 'matrix → out/matrix/{@entities}.mat  log → out/log/{@entities}.txt');
  extension.deactivate();
});

test('labels one path per line, naming each product of a step with several', () => {
  const { pathHintLabels } = load({ SemanticTokensLegend: class {} });
  const labels = pathHintLabels([
    { product: 'a', line: 3, path: 'out/a.txt' },
    { product: 'w', line: 5, path: 'out/w.npz' },
    { product: 'q', line: 5, path: 'out/q.json' }
  ]);
  assert.deepEqual([...labels], [[3, '→ out/a.txt'], [5, 'w → out/w.npz  q → out/q.json']]);
});

test('checks a .spitout\'s records on their own', { skip: !fs.existsSync(binary) }, async () => {
  const results = new Map();
  const document = fakeDocument(path.join(__dirname, 'inputs.spitout'), 'sources:\n    raw[id=1]\n');
  const extension = load(mockVscode(document, results, () => {}));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  await until(() => results.get(document.uri.toString())?.length === 0);
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
      const text = this.text.split('\n')[index];
      return { text, range: new Range(index, 0, index, text.length) };
    }
  };
}

function mockVscode(document, results, onChange, hints = {}) {
  const disposable = { dispose() {} };
  return {
    EventEmitter: class {
      constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return disposable; }; }
      fire() { for (const listener of this.listeners) listener(); }
      dispose() {}
    },
    InlayHint: class {
      constructor(position, label) { Object.assign(this, { position, label }); }
    },
    Uri: {
      file(fsPath) { return { fsPath, toString() { return `file://${this.fsPath}`; } }; },
      parse: value => ({ toString: () => value })
    },
    Range,
    Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
    MarkdownString: class {
      constructor() { this.value = ''; this.parts = []; }
      appendCodeblock(value, language) { this.parts.push({ code: value, language }); this.value += `\`\`\`${language}\n${value}\n\`\`\``; return this; }
      appendText(value) { this.parts.push({ text: value }); this.value += value; return this; }
      appendMarkdown(value) { this.parts.push({ markdown: value }); this.value += value; return this; }
    },
    Diagnostic: class {
      constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
    },
    DiagnosticRelatedInformation: class {
      constructor(location, message) { Object.assign(this, { location, message }); }
    },
    Location: class {
      constructor(uri, range) { Object.assign(this, { uri, range }); }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    SemanticTokensLegend: class {},
    SemanticTokensBuilder: class {},
    languages: {
      registerHoverProvider(_selector, provider) { hints.hover = provider; return { ...disposable, hoverProvider: provider }; },
      createDiagnosticCollection() {
        return {
          set(uri, items) { results.set(uri.toString(), items); },
          delete(uri) { results.delete(uri.toString()); },
          dispose() {}
        };
      },
      registerDocumentSemanticTokensProvider() { return disposable; },
      registerInlayHintsProvider(_selector, provider) { hints.provider = provider; return disposable; }
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

test('highlights a .spitout\'s products, dimensions and values by role', () => {
  const vscode = {
    Uri: { parse: value => ({ toString: () => value }) },
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
      registerHoverProvider() { return { dispose() {} }; },
      createDiagnosticCollection() { return { set() {}, delete() {}, dispose() {} }; },
      registerDocumentSemanticTokensProvider(_selector, provider) { return { dispose() {}, provider }; },
      registerInlayHintsProvider() { return { dispose() {} }; }
    },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
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
    delete require.cache[require.resolve('./extension')];
  }
  assert.ok(registered, 'semantic tokens provider was registered');
  const types = ['variable', 'parameter', 'enumMember'];
  const records = [
    'source_paths:',
    '    image: data/{sub}/image.nii.gz',
    '',
    'contexts sessions:',
    '    [site=A,device=D1]',
    'sources:',
    '    reading[site=A,device=D1]',
    '    testset'
  ];
  const tokens = registered.provideDocumentSemanticTokens({
    getText() { return records.join('\n'); },
    lineCount: records.length,
    lineAt(index) { return { text: records[index] }; }
  });
  const at = (line, needle) => tokens.find(t => t.line === line && records[line].slice(t.char, t.char + t.length) === needle);
  assert.equal(at(4, 'site').tokenType, types.indexOf('parameter'));
  assert.equal(at(4, 'D1').tokenType, types.indexOf('enumMember'));
  assert.equal(at(6, 'reading').tokenType, types.indexOf('variable'));
  assert.equal(at(6, 'device').tokenType, types.indexOf('parameter'));
  assert.equal(at(6, 'D1').tokenType, types.indexOf('enumMember'));
  assert.ok(!tokens.some(t => t.line === 1), 'a path rule is left to the grammar');

  // A pipeline is colored by the grammar alone.
  const pipeline = ['source reading [site]', 'operation f(reading) -> Out', 'out = f(reading)'];
  const none = registered.provideDocumentSemanticTokens({
    getText() { return pipeline.join('\n'); },
    lineCount: pipeline.length,
    lineAt(index) { return { text: pipeline[index] }; }
  });
  assert.equal(none.length, 0);
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

test('hovers explain specialised operations and inferred products from unsaved text', { skip: !fs.existsSync(binary) }, async () => {
  const document = fakeDocument(path.join(__dirname, 'hover.spit'), [
    'source raw: Frame<Native> [id]',
    'operation copy(input: Frame<S>) -> Frame<S>',
    'path: result/{@product}/{@entities}.txt',
    'out = copy(raw)',
    ''
  ].join('\n'));
  const results = new Map();
  let onChange;
  const vscode = mockVscode(document, results, callback => { onChange = callback; });
  const extension = load(vscode);
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
  const hover = character => provider.provideHover(document, { line: 3, character });
  try {
    const operation = await hover(7);
    assert.match(operation.contents.value, /operation copy\(input: Frame<\$S>\)/);
    assert.match(operation.contents.value, /S = Native/);
    assert.match(operation.contents.value, /out: Frame<Native> \[id\]/);
    assert.ok(operation.contents.parts.some(part => part.code === 'S = Native'));
    assert.ok(operation.contents.parts.some(part => part.code === 'output → out: Frame<Native> [id]'));
    assert.deepEqual(span(operation), [3, 6, 10]);
    const product = await hover(1);
    assert.match(product.contents.value, /out: Frame<Native> \[id\]/);
    assert.match(product.contents.value, /pipeline default/);
    assert.equal(product.contents.isTrusted, false);
    assert.equal(product.contents.supportHtml, false);
    assert.ok(product.contents.parts.filter(part => part.markdown).every(part => part.markdown === '\n\n'), 'symbol information is rendered as escaped text');
    assert.equal(await hover(10), null, 'the opening parenthesis is outside the name');
    const cancelled = await provider.provideHover(document, { line: 3, character: 7 }, { isCancellationRequested: true });
    assert.equal(cancelled, undefined);

    document.text = document.text.replace('Frame<Native>', 'Frame<Target>');
    document.version++;
    onChange({ document });
    assert.match((await hover(1)).contents.value, /out: Frame<Target>/, 'unsaved edits invalidate previous types');
    document.text += 'broken syntax\n';
    document.version++;
    onChange({ document });
    assert.match((await hover(1)).contents.value, /out: Frame<Target>/, 'independent declarations survive a broken line');
    assert.ok(results.get(document.uri.toString()).some(item => item.severity === 0));
    document.text = document.text.replace('Frame<Target>', 'Frame<Other>');
    document.version++;
    onChange({ document });
    const stale = hover(1);
    document.text = document.text.replace('Frame<Other>', 'Frame<Current>');
    document.version++;
    onChange({ document });
    assert.equal(await stale, undefined, 'discard a check interrupted by a new document version');
    assert.match((await hover(1)).contents.value, /out: Frame<Current>/);
  } finally {
    extension.deactivate();
  }
});

test('hovers show a folder\'s `/`', { skip: !fs.existsSync(binary) }, async () => {
  const document = fakeDocument(path.join(__dirname, 'folders.spit'), [
    'source dicom : Dicom / [sub]',
    'operation recon(scan: Dicom) -> FsSubject /',
    'subject = recon(dicom)',
    ''
  ].join('\n'));
  const extension = load(mockVscode(document, new Map(), () => {}));
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
  try {
    const source = await provider.provideHover(document, { line: 0, character: 8 });
    assert.match(source.contents.value, /dicom: Dicom \/ \[sub\]/);
    const operation = await provider.provideHover(document, { line: 2, character: 11 });
    assert.match(operation.contents.value, /operation recon\(scan: Dicom\) -> FsSubject \//);
  } finally {
    extension.deactivate();
  }
});

test('product hover separates user-defined snippets from prose', { skip: !fs.existsSync(binary) }, async () => {
  const pipeline = path.resolve(path.dirname(binary), '..', '..', 'examples', 'commands', 'field_survey', 'field_survey.spit');
  const text = fs.readFileSync(pipeline, 'utf8');
  const document = fakeDocument(pipeline, text);
  const extension = load(mockVscode(document, new Map(), () => {}));
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  try {
    const lines = text.split('\n');
    const line = lines.findIndex(value => value.trimStart().startsWith('source flat_field '));
    const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
    const hover = await provider.provideHover(document, { line, character: lines[line].indexOf('flat_field') });
    const code = hover.contents.parts.filter(part => part.code).map(part => part.code);
    assert.ok(code.includes('flat_field: Image<Flat,Captured> .raw [site, visit]'));
    assert.ok(code.includes('flat_img = import_flat(…)'));
    assert.ok(code.includes('site-{site}/visit-{visit}/calibration/site-{site}_visit-{visit}_flat.raw'));
    assert.ok(hover.contents.parts.some(part => part.text === 'Source product: a family of input artifacts.'));
    assert.ok(hover.contents.parts.some(part => part.text === '(explicit product rule).'));
    assert.ok(hover.contents.parts.filter(part => part.markdown).every(part => part.markdown === '\n\n'));
  } finally {
    extension.deactivate();
  }
});

test('saving an imported pipeline invalidates cached hover types', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-hover-import-'));
  const imported = path.join(folder, 'lib.spit');
  fs.writeFileSync(imported, 'source raw : Frame<Native> [id]\noperation copy(input: Frame<S>) -> Frame<S>\n');
  const document = fakeDocument(path.join(folder, 'main.spit'), 'use lib.spit as lib\nout = lib::copy(lib::raw)\n');
  const vscode = mockVscode(document, new Map(), () => {});
  let refresh;
  const disposable = { dispose() {} };
  vscode.workspace.createFileSystemWatcher = () => ({
    ...disposable,
    onDidChange(callback) { refresh = callback; return disposable; },
    onDidCreate() { return disposable; },
    onDidDelete() { return disposable; }
  });
  const extension = load(vscode);
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
  const hover = () => provider.provideHover(document, { line: 1, character: 1 });
  try {
    assert.match((await hover()).contents.value, /Frame<Native>/);
    fs.writeFileSync(imported, 'source raw : Frame<Target> [id]\noperation copy(input: Frame<S>) -> Frame<S>\n');
    refresh({ toString: () => `file://${imported}` });
    assert.match((await hover()).contents.value, /Frame<Target>/);
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('untrusted or non-file documents do not provide hovers', () => {
  const document = fakeDocument(path.join(__dirname, 'untrusted.spit'), 'source raw [id]\n');
  const results = new Map();
  const vscode = mockVscode(document, results, () => {});
  vscode.workspace.isTrusted = false;
  const extension = load(vscode);
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
  return (async () => {
    try {
      assert.equal(await provider.provideHover(document, { line: 0, character: 8 }), undefined);
      assert.equal(results.size, 0);
      vscode.workspace.isTrusted = true;
      document.uri.scheme = 'untitled';
      assert.equal(await provider.provideHover(document, { line: 0, character: 8 }), undefined);
      document.uri.scheme = 'file';
      document.languageId = 'plaintext';
      assert.equal(await provider.provideHover(document, { line: 0, character: 8 }), undefined);
    } finally { extension.deactivate(); }
  })();
});

test('hovers reuse one compiler analysis per document version', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-hover-cache-'));
  const wrapper = path.join(folder, 'counted-spit');
  const calls = path.join(folder, 'calls.jsonl');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
`, { mode: 0o755 });
  const document = fakeDocument(path.join(folder, 'cached.spit'), 'source raw [id]\noperation copy(input)\nout = copy(raw)\n');
  const results = new Map();
  let onChange;
  const vscode = mockVscode(document, results, callback => { onChange = callback; });
  vscode.workspace.getConfiguration = () => ({ get: () => wrapper });
  const extension = load(vscode);
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
  const hover = () => provider.provideHover(document, { line: 2, character: 1 });
  const recorded = () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  try {
    const firstHover = await hover();
    assert.ok(firstHover, JSON.stringify([...results.values()]));
    assert.match(firstHover.contents.value, /out: Unknown \[id\]/);
    assert.deepEqual(results.get(document.uri.toString()), []);
    assert.equal(recorded().length, 1);
    assert.ok(recorded()[0].includes('--hovers'));
    await hover();
    await hover();
    assert.equal(recorded().length, 1, 'hover reuses the completed document check');
    const changedTime = new Date(Date.now() + 2000);
    fs.utimesSync(wrapper, changedTime, changedTime);
    await hover();
    assert.equal(recorded().length, 2, 'rebuilding the executable invalidates cached hover data');
    document.text += 'broken syntax\n';
    document.version++;
    onChange({ document });
    await hover();
    assert.equal(recorded().length, 3, 'one new analysis for the edited version');
    assert.ok(results.get(document.uri.toString()).some(item => item.severity === 0));
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('hovering shows SPIT\'s explanation of a word or a name, and nothing in a comment', { skip: !fs.existsSync(binary) }, async () => {
  const hints = {};
  const text = 'source raw [id, run]\noperation mean(items: many) -> .txt\ncommand mean: cat {items} > {@output}  # vary\ntotal = mean(raw @ vary(run))\n';
  const document = fakeDocument(path.join(__dirname, 'hover.spit'), text);
  const extension = load(mockVscode(document, new Map(), () => {}, hints));
  extension.activate({ extensionPath: __dirname, subscriptions: [] });
  const at = async (line, word, from = 0) => {
    const character = document.lineAt(line).text.indexOf(word, from) + 1;
    return hints.hover.provideHover(document, { line, character });
  };

  const vary = await at(3, 'vary');
  assert.deepEqual(span(vary), [3, 19, 23]);
  assert.match(vary.contents.value, /^```spit\naverage = mean\(processed @ vary\(run\)\)\n```\n\nCollects a `many` input/);
  assert.match(vary.contents.value, /\[Language reference\]\(https:\/\/github\.com\/eclnz\/spit\/blob\/main\/docs\/language-reference\.md#operations-and-commands\)$/);

  const total = await at(3, 'total');
  assert.match(total.contents.value, /^```spit\ntotal: Unknown \[id\]\n```/);
  assert.equal(await at(2, 'vary'), null, 'a comment explains nothing');
  assert.equal(await at(3, 'run', 20), null, 'a dimension has no hover');
  extension.deactivate();
});

test('a recipe and a .spitout explain SPIT\'s words, and a .spitout\'s records are checked', { skip: !fs.existsSync(binary) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-vscode-'));
  fs.writeFileSync(path.join(folder, 'analysis.spit'), 'source raw [id]\noperation copy(input)\nresult = copy(raw)\npath raw: in/{id}.txt\n');
  const hints = {};
  const recipe = fakeDocument(path.join(folder, 'cohort.spitin'), 'pipeline analysis.spit\nroot .\nrequire [id] where raw count>=1\n');
  let extension = load(mockVscode(recipe, new Map(), () => {}, hints));
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    // `where` in `require [id] where raw count>=1`.
    const where = await hints.hover.provideHover(recipe, { line: 2, character: 14 });
    assert.match(where.contents.value, /a `require` rule's condition/);
    extension.deactivate();

    const results = new Map();
    const inputs = fakeDocument(path.join(folder, 'inputs.spitout'), 'sources:\n    raw[id=1\n');
    extension = load(mockVscode(inputs, results, () => {}, hints));
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.get(inputs.uri.toString())?.length === 1);
    assert.deepEqual(span(results.get(inputs.uri.toString())[0]), [1, 8, 12]);
    const header = await hints.hover.provideHover(inputs, { line: 0, character: 2 });
    assert.match(header.contents.value, /settled source identities/);
  } finally {
    extension.deactivate();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('hovering shows SPIT\'s explanation of a shape on a source placeholder', { skip: !fs.existsSync(binary) }, async () => {
  const hints = {};
  const text = 'source log [server, date]\noperation copy(input)\nresult = copy(log)\npath log: logs/{server}/{date:date}.log\n';
  const document = fakeDocument(path.join(__dirname, 'shape.spit'), text);
  const results = new Map();
  const extension = load(mockVscode(document, results, () => {}, hints));
  try {
    extension.activate({ extensionPath: __dirname, subscriptions: [] });
    await until(() => results.get(document.uri.toString())?.length === 0);

    // The `check --json --hovers` output names the shape among the words, with a doc of kind `shape`.
    const output = require('node:child_process').spawnSync(binary, ['check', 'shape.spit', '--json', '--stdin', '--hovers'], { input: text, encoding: 'utf8', cwd: __dirname });
    const checked = JSON.parse(output.stdout);
    const line = text.split('\n')[3];
    const shape = checked.words.filter(word => word.word === 'date' && word.line === 4);
    assert.equal(shape.length, 1, 'the shape is one word, and the dimension before the colon is not');
    assert.equal(shape[0].column - 1, line.indexOf(':date') + 1);
    assert.equal(checked.word_docs.date.kind, 'shape');

    // Hovering the shape shows that doc; hovering the dimension named `date` before the colon shows none.
    const hover = await hints.hover.provideHover(document, { line: 3, character: line.indexOf(':date') + 2 });
    assert.deepEqual(span(hover), [3, line.indexOf(':date') + 1, line.indexOf(':date') + 5]);
    assert.match(hover.contents.value, /^```spit\npath log: logs\/\{server\}\/\{date:date\}\.log\n```\n\nA shape for a placeholder in a source's path rule/);
    assert.match(hover.contents.value, /\[Language reference\]\(https:\/\/github\.com\/eclnz\/spit\/blob\/main\/docs\/language-reference\.md#shapes-on-a-source-placeholder\)$/);
    assert.equal(await hints.hover.provideHover(document, { line: 3, character: line.indexOf('{date') + 2 }), null, 'the dimension has no hover');
  } finally {
    extension.deactivate();
  }
});

test('multiline signatures preserve diagnostic and hover ranges in unsaved edits', { skip: !fs.existsSync(binary) }, async () => {
  const document = fakeDocument(path.join(__dirname, 'multiline.spit'), 'operation broken(\n    first: Image,\n    second: Image<Bad]>\n) -> Image\noperation later(\n    x: Image\n) -> Image\n');
  const results = new Map();
  let onChange;
  const extension = load(mockVscode(document, results, callback => { onChange = callback; }));
  const context = { extensionPath: __dirname, subscriptions: [] };
  extension.activate(context);
  const provider = context.subscriptions.find(item => item.hoverProvider).hoverProvider;
  try {
    await until(() => results.get(document.uri.toString())?.length === 1);
    assert.deepEqual(span(results.get(document.uri.toString())[0]), [2, 21, 22]);
    const later = await provider.provideHover(document, { line: 4, character: 11 });
    assert.match(later.contents.value, /operation later/);
    assert.deepEqual(span(later), [4, 10, 15]);
    document.text = document.text.replace('Image<Bad]>', 'Image<Bad>');
    document.version++;
    onChange({ document });
    await until(() => results.get(document.uri.toString())?.length === 0);
    const fixed = await provider.provideHover(document, { line: 0, character: 11 });
    assert.match(fixed.contents.value, /operation broken/);
  } finally {
    extension.deactivate();
  }
});
