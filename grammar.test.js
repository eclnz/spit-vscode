const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Tokenize with the engine VS Code itself uses. Run `npm install` first.
let textmate;
let oniguruma;
try {
  textmate = require('vscode-textmate');
  oniguruma = require('vscode-oniguruma');
} catch {}

async function tokenizer() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: text => new oniguruma.OnigString(text)
    }),
    loadGrammar: async () => textmate.parseRawGrammar(
      fs.readFileSync(path.join(__dirname, 'syntaxes', 'spit.tmLanguage.json'), 'utf8'),
      'spit.tmLanguage.json'
    )
  });
  const grammar = await registry.loadGrammar('source.spit');
  // The scopes of the token covering `text` on the one line given.
  return (line, text, from = 0) => {
    const { tokens } = grammar.tokenizeLine(line, textmate.INITIAL);
    const start = line.indexOf(text, from);
    assert.notEqual(start, -1, `\`${text}\` not in \`${line}\``);
    const token = tokens.find(token => token.startIndex <= start && start < token.endIndex);
    return token.scopes.join(' ');
  };
}

const skip = !textmate && 'run npm install to test the grammar';

test('path templates mark the reserved placeholders apart from dimensions', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'path t1_to_dwi_flirt: derivatives/{stage}/{product}/{entities}_{sub}.mat';
  assert.match(scopes(line, 'path'), /keyword\.control\.spit/);
  assert.match(scopes(line, 't1_to_dwi_flirt'), /variable\.other\.product\.spit/);
  for (const name of ['stage', 'product', 'entities']) {
    assert.match(scopes(line, name, line.indexOf('{')), /variable\.language\.placeholder\.spit/, name);
  }
  assert.match(scopes(line, 'sub', line.indexOf('{sub')), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes(line, '{', line.indexOf('{sub')), /punctuation\.definition\.template-expression\.begin/);
});

test('directory discovery marks its name, dimensions, and path captures', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'discover sessions: [sub, ses] from dirs data/sub-{sub}/ses-{ses}';
  assert.match(scopes(line, 'discover'), /keyword\.control\.discovery\.spit/);
  assert.match(scopes(line, 'sessions'), /entity\.name\.collection\.spit/);
  assert.match(scopes(line, ':'), /punctuation\.separator\.colon\.spit/);
  assert.match(scopes(line, 'sub', line.indexOf('[')), /variable\.parameter\.dimension\.spit/);
  assert.match(scopes(line, 'ses', line.indexOf('[')), /variable\.parameter\.dimension\.spit/);
  assert.match(scopes(line, 'from'), /keyword\.control\.discovery\.spit/);
  assert.match(scopes(line, 'dirs'), /keyword\.other\.discovery\.spit/);
  assert.match(scopes(line, 'sub', line.indexOf('{sub')), /variable\.parameter\.placeholder\.dimension\.spit/);
});

test('named discovery contexts have a section header', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'contexts sessions:';
  assert.match(scopes(line, 'contexts'), /keyword\.other\.section\.spit/);
  assert.match(scopes(line, 'sessions'), /entity\.name\.section\.discovery\.spit/);
});

test('require and drop rules highlight comparisons and groups', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'require sessions count!=2 per [sub]';
  assert.match(scopes(line, 'require'), /keyword\.control/);
  assert.match(scopes(line, 'sessions'), /variable\.other\.product/);
  assert.match(scopes(line, 'count'), /keyword\.other\.count/);
  assert.match(scopes(line, 'sub'), /meta\.dimension-list/);
  for (const comparison of ['=', '!=', '>=', '<=', '>', '<']) {
    const rule = `drop [sub] where sessions count${comparison}2`;
    assert.match(scopes(rule, 'drop'), /keyword\.control\.constraint/);
    assert.match(scopes(rule, 'where'), /keyword\.control\.constraint/);
    assert.match(scopes(rule, 'sessions'), /variable\.other\.product/);
    assert.match(scopes(rule, 'count'), /keyword\.other\.count/);
    assert.match(scopes(rule, comparison, rule.indexOf('count')), /keyword\.operator\.comparison/);
  }
  for (const condition of ['missing', 'has']) {
    const rule = `drop [sub] where bold ${condition} run=2`;
    assert.match(scopes(rule, condition), /keyword\.control\.constraint/);
  }
});

test('exclude rules highlight a product or an external file', { skip }, async () => {
  const scopes = await tokenizer();
  const named = 'exclude bold[sub=02,ses=01,run=3]';
  assert.match(scopes(named, 'exclude'), /keyword\.control\.constraint/);
  assert.match(scopes(named, 'bold'), /variable\.other\.product/);
  assert.match(scopes('exclude from qc/excluded.csv', 'from'), /keyword\.control\.constraint/);
  assert.match(scopes('exclude from qc/excluded.csv', 'qc/excluded.csv'), /string\.unquoted\.file/);
  assert.doesNotMatch(scopes('skip sessions count>=2 per [sub]', 'skip'), /keyword\.control/);
});

test('a default path rule, a comment, and escaped braces', { skip }, async () => {
  const scopes = await tokenizer();
  const line = '    path: out/{{literal}}/{run}.txt # per stage';
  assert.match(scopes(line, 'path'), /keyword\.control\.spit/);
  assert.match(scopes(line, '{{'), /constant\.character\.escape\.brace\.spit/);
  assert.doesNotMatch(scopes(line, 'literal'), /placeholder/);
  assert.match(scopes(line, 'run'), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes(line, '# per stage'), /comment\.line/);
  // As in SPIT, a `#` inside a word is not a comment.
  assert.doesNotMatch(scopes('path: out/#tag/{entities}', '#tag'), /comment/);
});

test('a product called `path` is still a step', { skip }, async () => {
  const scopes = await tokenizer();
  assert.match(scopes('path = copy(raw)', 'path'), /variable\.other\.product\.spit/);
});

test('stage headers are keywords with a section name', { skip }, async () => {
  const scopes = await tokenizer();
  for (const line of ['stage preprocess:', '    stage denoise:  # nested']) {
    assert.match(scopes(line, 'stage'), /keyword\.control\.stage\.spit/);
    assert.match(scopes(line, line.includes('denoise') ? 'denoise' : 'preprocess'), /entity\.name\.section\.stage\.spit/);
  }
  // A product called `stage` is assigned, not opened.
  assert.doesNotMatch(scopes('stage = copy(raw)', 'stage'), /keyword\.control\.stage/);
});

test('command templates mark {output} apart from the ports they name', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'command estimate_fods: dwi2fod msmt_csd {dwi} {wm} {input} {output}';
  assert.match(scopes(line, 'output', line.indexOf('{output')), /variable\.language\.placeholder\.spit/);
  // A port is named, so `{input}` is a port like any other.
  for (const name of ['dwi', 'input']) {
    assert.match(scopes(line, name, line.indexOf(`{${name}`)), /variable\.parameter\.placeholder\.spit/, name);
    assert.doesNotMatch(scopes(line, name, line.indexOf(`{${name}`)), /variable\.language/, name);
  }
});

test('a dimensions line marks the pipeline order', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'dimensions [model, config, seed]';
  assert.match(scopes(line, 'dimensions'), /keyword\.control\.spit/);
  assert.match(scopes(line, 'config'), /variable\.parameter\.dimension\.spit/);
  // A product called `dimensions` is assigned, not declared.
  assert.doesNotMatch(scopes('dimensions = copy(raw)', 'dimensions'), /keyword\.control/);
});

test('an operation signature marks many and min', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'operation fit(waves: many Table, policy: Policy) -> Coef @ min(2)';
  assert.match(scopes(line, 'operation'), /keyword\.control\.spit/);
  assert.match(scopes(line, 'fit'), /entity\.name\.function\.spit/);
  assert.match(scopes(line, 'many'), /storage\.modifier\.cardinality\.spit/);
  assert.match(scopes(line, 'min'), /keyword\.other\.selector\.spit/);
  // `drop` and `one` are no longer operation keywords.
  assert.doesNotMatch(scopes('operation f(x: one Image) -> Image', 'one'), /cardinality/);
});

test('an operation output may name the extension its file has', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'operation align(moving: Image<M,S>) -> ToolTransform<S,T> .mat';
  assert.match(scopes(line, 'ToolTransform'), /support\.type\.spit/);
  assert.match(scopes(line, '.mat'), /constant\.other\.extension\.spit/);
  const several = 'operation fit(runs: many Data) -> (weights: Weights .npz, quality: Metrics .tar.gz) @ min(2)';
  assert.match(scopes(several, 'weights', several.indexOf('->')), /variable\.parameter\.port\.spit/);
  assert.match(scopes(several, 'Weights'), /support\.type\.spit/);
  assert.match(scopes(several, '.npz'), /constant\.other\.extension\.spit/);
  assert.match(scopes(several, '.tar.gz'), /constant\.other\.extension\.spit/);
  assert.match(scopes(several, 'min'), /keyword\.other\.selector\.spit/);
});

test('ext: sets the extension a default path is completed with', { skip }, async () => {
  const scopes = await tokenizer();
  const line = '    ext: .nii.gz  # images in this stage';
  assert.match(scopes(line, 'ext'), /keyword\.control\.spit/);
  assert.match(scopes(line, '.nii.gz'), /constant\.other\.extension\.spit/);
  assert.match(scopes(line, '# images'), /comment\.line/);
  // A step's output named `ext` stays a step.
  assert.doesNotMatch(scopes('ext: Image = copy(raw)', 'ext'), /keyword\.control/);
});

test('each is a selector keyword', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'forecast = predict(reading, model @ each(scenario), parameters)';
  assert.match(scopes(line, 'each'), /keyword\.other\.selector\.spit/);
});

test('placeholders show in double quotes, and single-quoted text is literal', { skip }, async () => {
  const scopes = await tokenizer();
  const line = `command label: tool "--in={input}" '{print $1}' {output}`;
  assert.match(scopes(line, 'input'), /variable\.parameter\.placeholder\.spit/);
  assert.doesNotMatch(scopes(line, 'print'), /placeholder/);
  assert.match(scopes(line, 'print'), /string\.quoted\.single\.spit/);
});

test('a recipe names its pipeline', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'pipeline analysis.spit  # the pipeline this recipe serves';
  assert.match(scopes(line, 'pipeline'), /keyword\.control\.import\.spit/);
  assert.match(scopes(line, 'analysis.spit'), /string\.unquoted\.file\.spit/);
  assert.match(scopes(line, '# the'), /comment\.line/);
  // A product called `pipeline` stays a product, and the removed section
  // header is not a header.
  assert.doesNotMatch(scopes('pipeline:', 'pipeline'), /keyword\.other\.section\.spit/);
  assert.doesNotMatch(scopes('pipeline = copy(raw)', 'pipeline'), /keyword\.control\.import/);
});

test('a recipe or a .spitout names its dataset root', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'root ../data  # where the dataset is';
  assert.match(scopes(line, 'root'), /keyword\.control\.import\.spit/);
  assert.match(scopes(line, '../data'), /string\.unquoted\.file\.spit/);
  assert.match(scopes(line, '# where'), /comment\.line/);
  // A product or record called `root` stays one.
  assert.doesNotMatch(scopes('root = copy(raw)', 'root'), /keyword\.control\.import/);
  assert.doesNotMatch(scopes('    root[sub=01]', 'root'), /keyword\.control\.import/);
});

test('records mark the product and its dimensions', { skip }, async () => {
  const scopes = await tokenizer();
  const line = '    image[sub=01,ses=01]';
  assert.match(scopes(line, 'image'), /variable\.other\.product\.spit/);
  assert.match(scopes(line, 'sub'), /variable\.parameter/);
  assert.match(scopes('    testset', 'testset'), /variable\.other\.product\.spit/);
  for (const header of ['sources:', 'source_paths:', 'contexts:', 'removed:']) {
    assert.match(scopes(header, header.slice(0, -1)), /keyword\.other\.section\.spit/, header);
  }
});
