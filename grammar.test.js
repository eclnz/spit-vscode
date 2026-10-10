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
  const scopes = (line, text, from = 0) => {
    const { tokens } = grammar.tokenizeLine(line, textmate.INITIAL);
    const start = line.indexOf(text, from);
    assert.notEqual(start, -1, `\`${text}\` not in \`${line}\``);
    const token = tokens.find(token => token.startIndex <= start && start < token.endIndex);
    return token.scopes.join(' ');
  };
  // The scopes of `text` on line number `index` of a multi-line `lines`.
  scopes.inFile = (lines, index, text, from = 0) => {
    let state = textmate.INITIAL;
    for (let i = 0; i < index; i++) state = grammar.tokenizeLine(lines[i], state).ruleStack;
    const { tokens } = grammar.tokenizeLine(lines[index], state);
    const start = lines[index].indexOf(text, from);
    assert.notEqual(start, -1, `\`${text}\` not in \`${lines[index]}\``);
    return tokens.find(token => token.startIndex <= start && start < token.endIndex).scopes.join(' ');
  };
  return scopes;
}

const skip = !textmate && 'run npm install to test the grammar';

test('entities templates and aliases highlight their roles without reserving product names', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'entities: {key}_{value} separated "-" empty "all"';
  for (const keyword of ['entities', 'separated', 'empty']) {
    assert.match(scopes(line, keyword), /keyword\.control\.spit/);
  }
  for (const name of ['key', 'value']) {
    assert.match(scopes(line, name), /variable\.language\.placeholder\.spit/);
    for (const quote of ['"', "'"]) {
      const quoted = `entities: ${quote}{key}_{value}${quote} separated "-"`;
      assert.match(scopes(quoted, name), /variable\.language\.placeholder\.spit/);
    }
  }
  assert.match(scopes(line, '-'), /string\.quoted\.double\.spit/);
  const alias = 'entities sub: subject';
  assert.match(scopes(alias, 'entities'), /keyword\.control\.spit/);
  assert.match(scopes(alias, 'sub'), /variable\.parameter\.dimension\.spit/);
  assert.match(scopes(alias, 'subject'), /constant\.other\.entity-label\.spit/);
  assert.match(scopes('entities = copy(raw)', 'entities'), /variable\.other\.product\.spit/);
  assert.doesNotMatch(scopes('entities : Image [sub] = copy(raw)', 'entities'), /keyword\.control/);
  assert.doesNotMatch(scopes('entities: Image [sub] = copy(raw)', 'entities'), /keyword\.control/);
});

test('path templates mark the built-in placeholders apart from dimensions', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'path t1_to_dwi_flirt: derivatives/{@stage}/{@product}/{@entities}_{sub}_{stage}.mat';
  assert.match(scopes(line, 'path'), /keyword\.control\.spit/);
  assert.match(scopes(line, 't1_to_dwi_flirt'), /variable\.other\.product\.spit/);
  for (const name of ['@stage', '@product', '@entities']) {
    assert.match(scopes(line, name, line.indexOf('{')), /variable\.language\.placeholder\.spit/, name);
  }
  assert.match(scopes(line, 'sub', line.indexOf('{sub')), /variable\.parameter\.placeholder\.dimension\.spit/);
  // Without `@`, `stage` is a dimension.
  assert.match(scopes(line, 'stage', line.indexOf('{stage')), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes(line, '{', line.indexOf('{sub')), /punctuation\.definition\.template-expression\.begin/);
});

test('path templates mark optional groups, literal brackets and labels', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'path: derivatives/sub-{sub}[/ses-{ses}][[x]]/{@labels}_{@product}';
  assert.match(scopes(line, '[', line.indexOf('[/')), /punctuation\.definition\.optional\.spit/);
  assert.match(scopes(line, ']', line.indexOf('}]') + 1), /punctuation\.definition\.optional\.spit/);
  assert.match(scopes(line, '[[', line.indexOf('[[')), /constant\.character\.escape\.bracket\.spit/);
  assert.match(scopes(line, ']]', line.indexOf(']]')), /constant\.character\.escape\.bracket\.spit/);
  assert.match(scopes(line, 'ses', line.indexOf('{ses')), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes(line, '@labels'), /variable\.language\.placeholder\.spit/);
  const stem = '    path: site-{site}[_{shot}]';
  assert.match(scopes(stem, '[', stem.indexOf('[_')), /punctuation\.definition\.optional\.spit/);
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
  const line = 'require [sub] where sessions count!=2 has ses=1,2';
  assert.match(scopes(line, 'require'), /keyword\.control/);
  assert.match(scopes(line, 'sub'), /meta\.dimension-list/);
  assert.match(scopes(line, 'where'), /keyword\.control\.constraint/);
  assert.match(scopes(line, 'sessions'), /variable\.other\.product/);
  assert.match(scopes(line, 'count'), /keyword\.other\.count/);
  assert.match(scopes(line, 'has'), /keyword\.control\.constraint/);
  assert.match(scopes(line, 'ses', line.indexOf('has')), /variable\.parameter\.dimension/);
  const values = 'require [sub, ses] where bold has run=1,2';
  assert.match(scopes(values, 'has'), /keyword\.control\.constraint/);
  // `per` belonged to the old order and is no longer a keyword.
  assert.doesNotMatch(scopes('require sessions count>=2 per [sub]', 'per'), /keyword\.control/);
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
  assert.doesNotMatch(scopes('path: out/#tag/{@entities}', '#tag'), /comment/);
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

test('command templates mark an output\'s folder and name', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'command convert: dcm2niix -o {image.dir} -f {image.stem} {dicom} --log {@output.dir} --name {@output.stem}';
  assert.match(scopes(line, 'image', line.indexOf('{image.dir')), /variable\.parameter\.placeholder\.spit/);
  assert.match(scopes(line, 'dir', line.indexOf('{image.dir')), /variable\.other\.property\.spit/);
  assert.match(scopes(line, 'stem'), /variable\.other\.property\.spit/);
  for (const part of ['dir', 'stem']) {
    const at = line.indexOf(`{@output.${part}`);
    // The `@` is part of the built-in name, not the `@` of a selector.
    assert.match(scopes(line, '@', at), /variable\.language\.placeholder\.spit/, part);
    assert.doesNotMatch(scopes(line, '@', at), /keyword\.operator\.at/, part);
    assert.match(scopes(line, 'output', at), /variable\.language\.placeholder\.spit/, part);
    assert.match(scopes(line, part, at), /variable\.other\.property\.spit/, part);
  }
  assert.match(scopes(line, 'dicom'), /variable\.parameter\.placeholder\.spit/);
});

test('command templates mark {@output} apart from the ports they name', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'command estimate_fods: dwi2fod msmt_csd {dwi} {wm} {input} {@output}';
  const at = line.indexOf('{@output');
  assert.match(scopes(line, '@', at), /variable\.language\.placeholder\.spit/);
  assert.doesNotMatch(scopes(line, '@', at), /keyword\.operator\.at/);
  assert.match(scopes(line, 'output', at), /variable\.language\.placeholder\.spit/);
  // A port is named, so `{input}` is a port like any other.
  for (const name of ['dwi', 'input']) {
    assert.match(scopes(line, name, line.indexOf(`{${name}`)), /variable\.parameter\.placeholder\.spit/, name);
    assert.doesNotMatch(scopes(line, name, line.indexOf(`{${name}`)), /variable\.language/, name);
  }
  // SPIT rejects the old `{output}`, so it is not colored as a built-in.
  for (const old of ['command copy: cp {input} {output}', 'command copy: cp {input} {output.dir}']) {
    assert.doesNotMatch(scopes(old, 'output'), /variable\.language/, old);
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

test('a `/` after a type makes a source or an output a folder', { skip }, async () => {
  const scopes = await tokenizer();
  const source = 'source dicom : Dicom / [sub]';
  assert.match(scopes(source, 'Dicom'), /support\.type\.spit/);
  assert.match(scopes(source, '/'), /constant\.other\.extension\.folder\.spit/);
  assert.match(scopes(source, 'sub'), /variable\.other\.spit/);
  assert.match(scopes('source store .zarr/  # a store', '.zarr/'), /constant\.other\.extension\.folder\.spit/);
  const output = 'operation recon(t1: Image) -> (subject: FsSubject /, log: Text .txt)';
  assert.match(scopes(output, '/'), /constant\.other\.extension\.folder\.spit/);
  assert.match(scopes(output, '.txt'), /constant\.other\.extension\.spit/);
  assert.doesNotMatch(scopes(output, '.txt'), /folder/);
  const store = 'operation store(table) -> Zarr .zarr/';
  assert.match(scopes(store, '.zarr/'), /constant\.other\.extension\.folder\.spit/);
  // A `/` in a path stays part of the path.
  assert.doesNotMatch(scopes('path dicom: dicom/sub={sub}', '/'), /extension/);
});

test('an output written beside another names its suffix and sibling', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'operation strip(t1: Image) -> (brain: Image .nii.gz, mask: Image "_mask.nii.gz" beside brain, log .txt beside brain)';
  assert.match(scopes(line, '"_mask.nii.gz"'), /string\.quoted\.double\.spit/);
  assert.doesNotMatch(scopes(line, '.nii.gz"'), /constant\.other\.extension/);
  assert.match(scopes(line, 'beside'), /keyword\.other\.beside\.spit/);
  assert.match(scopes(line, 'brain', line.indexOf('beside')), /variable\.parameter\.port\.spit/);
  assert.match(scopes(line, '.txt'), /constant\.other\.extension\.spit/);
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

test('a sidecars block names its group, dimensions, stem and extensions', { skip }, async () => {
  const scopes = await tokenizer();
  const header = 'sidecars photo [site, shot]:  # with its pose';
  assert.match(scopes(header, 'sidecars'), /keyword\.control\.spit/);
  assert.match(scopes(header, 'photo'), /entity\.name\.section\.sidecars\.spit/);
  assert.match(scopes(header, 'site', header.indexOf('[')), /variable\.parameter/);
  assert.match(scopes(header, ':'), /punctuation\.separator\.colon\.spit/);
  assert.match(scopes(header, '# with'), /comment\.line/);
  // The stem is an indented `path:` line, or a recipe's `path photo:`.
  const stem = '    path: site-{site}/shot-{shot}_photo';
  assert.match(scopes(stem, 'path'), /keyword\.control\.spit/);
  assert.match(scopes(stem, 'shot', stem.indexOf('{shot}')), /variable\.parameter\.placeholder\.dimension\.spit/);
  const recipe = 'path photo: site-{site}/shot-{shot}_photo';
  assert.match(scopes(recipe, 'photo'), /variable\.other\.product\.spit/);
  const member = '    source photo_gps : GpsTrack .gpx  # the pose';
  assert.match(scopes(member, 'source'), /keyword\.control\.spit/);
  assert.match(scopes(member, 'GpsTrack'), /support\.type\.spit/);
  assert.match(scopes(member, '.gpx'), /constant\.other\.extension\.spit/);
  // Any source may declare its extension, before its dimensions.
  const source = 'source events : Events .nii.gz [sub, ses]';
  assert.match(scopes(source, '.nii.gz'), /constant\.other\.extension\.spit/);
  assert.match(scopes(source, 'sub'), /variable\.other\.spit/);
  assert.match(scopes('source events .tsv [sub]', '.tsv'), /constant\.other\.extension\.spit/);
  // A product called `sidecars` stays a step.
  assert.doesNotMatch(scopes('sidecars = copy(raw)', 'sidecars'), /keyword\.control/);
});

test('each is a selector keyword', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'forecast = predict(reading, model @ each(scenario), parameters)';
  assert.match(scopes(line, 'each'), /keyword\.other\.selector\.spit/);
});

test('placeholders show in double quotes, and single-quoted text is literal', { skip }, async () => {
  const scopes = await tokenizer();
  const line = `command label: tool "--in={input}" '{print $1}' {@output}`;
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

test('a pipeline, recipe or .spitout names its dataset root', { skip }, async () => {
  const scopes = await tokenizer();
  const line = 'root ../data  # where the dataset is';
  assert.match(scopes(line, 'root'), /keyword\.control\.import\.spit/);
  assert.match(scopes(line, '../data'), /string\.unquoted\.file\.spit/);
  assert.match(scopes(line, '# where'), /comment\.line/);
  assert.match(scopes('root data=set', 'data=set'), /string\.unquoted\.file\.spit/);
  // A product or record called `root` stays one.
  assert.doesNotMatch(scopes('root = copy(raw)', 'root'), /keyword\.control\.import/);
  assert.doesNotMatch(scopes('root : Text = copy(raw)', 'root'), /keyword\.control\.import/);
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

test('a shape after a source placeholder\'s colon is marked in path rules', { skip }, async () => {
  const scopes = await tokenizer();
  const log = 'path log: logs/{server}/{date:date}.log';
  const at = log.indexOf('{date');
  // A dimension named `date` keeps its placeholder scope; the shape is its own.
  assert.match(scopes(log, 'date', at), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.doesNotMatch(scopes(log, 'date', at), /shape/);
  assert.match(scopes(log, ':', at), /punctuation\.separator\.colon\.spit/);
  assert.match(scopes(log, 'date', at + 2), /constant\.language\.shape\.spit/);
  assert.match(scopes(log, '}', at), /punctuation\.definition\.template-expression\.end/);
  assert.match(scopes(log, 'server'), /variable\.parameter\.placeholder\.dimension\.spit/);
  const run = 'path run: raw/run-{run:digits}.csv';
  assert.match(scopes(run, 'run', run.indexOf('{run')), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes(run, 'digits'), /constant\.language\.shape\.spit/);
  assert.match(scopes(run, ':', run.indexOf('{run')), /punctuation\.separator\.colon\.spit/);
  // A recipe's default `path:` and a source's `path source:` are path rules too.
  const year = '    path: data/{site}/{year:year}/{@product}';
  assert.match(scopes(year, 'year', year.indexOf(':year') + 1), /constant\.language\.shape\.spit/);
  // A word that is not a shape is not marked as one.
  assert.doesNotMatch(scopes('path run: raw/{run:other}.csv', 'other'), /shape/);
});

test('a shape is marked in a discover pattern and in a .spitout\'s source_paths', { skip }, async () => {
  const scopes = await tokenizer();
  const discover = 'discover days: [day] from dirs data/{day:year}';
  assert.match(scopes(discover, 'day', discover.indexOf('{day')), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes(discover, 'year', discover.indexOf(':year')), /constant\.language\.shape\.spit/);
  const file = ['root ../data', 'source_paths:', '    log: logs/{server}/{date:date}.log  # one a day', '    run: raw/run-{run:digits}.csv', 'sources:', '    log[server=web1,date=2026-09-01]'];
  assert.match(scopes.inFile(file, 1, 'source_paths'), /keyword\.other\.section\.spit/);
  assert.match(scopes.inFile(file, 2, 'log'), /variable\.other\.product\.spit/);
  assert.match(scopes.inFile(file, 2, 'date', file[2].indexOf('{date') + 2), /constant\.language\.shape\.spit/);
  assert.match(scopes.inFile(file, 2, 'date', file[2].indexOf('{date')), /variable\.parameter\.placeholder\.dimension\.spit/);
  assert.match(scopes.inFile(file, 2, '# one'), /comment\.line/);
  assert.match(scopes.inFile(file, 3, 'digits'), /constant\.language\.shape\.spit/);
  // The next section ends the block, and its records are records again.
  assert.match(scopes.inFile(file, 4, 'sources'), /keyword\.other\.section\.spit/);
  assert.match(scopes.inFile(file, 5, 'log'), /variable\.other\.product\.spit/);
  assert.doesNotMatch(scopes.inFile(file, 5, 'date'), /shape/);
});

test('a `command` line\'s `{x:date}` is not a shape', { skip }, async () => {
  const scopes = await tokenizer();
  for (const line of ['command copy: tool {x:date} {@output}', 'verify test -s {x:digits}']) {
    const word = line.includes('date') ? 'date' : 'digits';
    assert.doesNotMatch(scopes(line, word), /shape/, line);
    assert.match(scopes(line, word), /variable\.parameter\.placeholder\.spit/, line);
  }
  const quoted = 'command copy: tool "--day={day:date}"';
  assert.doesNotMatch(scopes(quoted, 'date', quoted.indexOf(':date')), /shape/);
});

test('multiline operation lists keep their scopes through the closing delimiter', { skip }, async () => {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: text => new oniguruma.OnigString(text)
    }),
    loadGrammar: async () => textmate.parseRawGrammar(fs.readFileSync(path.join(__dirname, 'syntaxes', 'spit.tmLanguage.json'), 'utf8'), 'spit.tmLanguage.json')
  });
  const grammar = await registry.loadGrammar('source.spit');
  let state = textmate.INITIAL;
  const scopes = (line, word) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    const start = line.indexOf(word);
    return result.tokens.find(token => token.startIndex <= start && start < token.endIndex).scopes.join(' ');
  };
  assert.match(scopes('    operation prep(', 'prep'), /entity.name.function.spit/);
  assert.match(scopes('        images: many MRI<Native> @ min(2),', 'many'), /storage.modifier.cardinality.spit/);
  assert.match(scopes('        reference: MRI<Native>', 'MRI'), /support.type.spit/);
  assert.match(scopes('    ) -> (', '->'), /keyword.operator.arrow.spit/);
  assert.match(scopes('        mask: MRI<Mask,Grid<Native>>,', 'mask'), /variable.parameter.port.spit/);
  assert.match(scopes('        report: Json .json', '.json'), /constant.other.extension.spit/);
  scopes('    ):', ')');
  assert.match(scopes('        result = clean(images)', 'clean'), /entity.name.function.spit/);
  assert.match(scopes('operation later(x: Image) -> Image', 'later'), /entity.name.function.spit/);
});
