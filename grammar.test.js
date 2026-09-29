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

test('command templates mark the placeholders every operation has', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'command estimate_fods: dwi2fod msmt_csd {dwi} {wm} {input} {output} {inputs} {input2}';
  for (const name of ['{input}', '{output}', '{inputs}', '{input2}']) {
    assert.match(scopes(line, name.slice(1, -1), line.indexOf(name)), /variable\.language\.placeholder\.spit/, name);
  }
  assert.match(scopes(line, 'dwi', line.indexOf('{dwi')), /variable\.parameter\.placeholder\.spit/);
  assert.doesNotMatch(scopes(line, 'dwi', line.indexOf('{dwi')), /variable\.language/);
});

test('each is a selector keyword', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'forecast = predict(reading, model @ each(scenario), parameters)';
  assert.match(scopes(line, 'each'), /keyword\.other\.selector\.spit/);
});

test('placeholders show in double quotes, and single-quoted text is literal', { skip }, async () => {
  const scopes = await tokenizer();
  const line = `command label: tool "--in={input}" '{print $1}' {output}`;
  assert.match(scopes(line, 'input'), /variable\.language\.placeholder\.spit/);
  assert.doesNotMatch(scopes(line, 'print'), /placeholder/);
  assert.match(scopes(line, 'print'), /string\.quoted\.single\.spit/);
});
