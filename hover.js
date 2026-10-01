// Hover documentation for SPIT's own words: statement keywords, selectors,
// recipe rule words, built-in placeholders and `.spitout` headers. Each entry
// condenses a part of SPIT's language reference and links to the section
// it comes from. A name the file itself defines, such as a product, port or
// dimension, has no entry.

const REFERENCE = 'https://github.com/eclnz/spit/blob/main/docs/language-reference.md';

const BUILTINS = {
  source: {
    anchor: 'products-and-dimensions',
    example: 'source image : Image [subject, visit, run]\nsource calibration',
    text: 'Declares a product family, not one file: `image[subject=A,visit=1,run=2]` names one artifact. The type is optional. A source with no dimensions takes no brackets and names one artifact, which matches every job that takes it. Its files are found by its `path` rule.'
  },
  operation: {
    anchor: 'operations-and-commands',
    example: 'operation process(image: Image) -> Image\noperation estimate(dwi: DWI) -> (wm: Response, gm: Response)',
    text: 'Declares a step\'s input ports and outputs, before its first use. A port is `name`, `name: Type`, `name: many` or `name: many Type`. A call fills the ports in order, and SPIT checks each product\'s type against its port. Several outputs are each named, and an output\'s type may be followed by the extension the tool gives its file, as in `-> Transform .mat`.'
  },
  command: {
    anchor: 'operations-and-commands',
    example: 'command process: process_tool --in {image} --out {output}',
    text: 'The program an operation runs. Each `{port}` is filled in with an artifact\'s path, and every output must appear, or its `.dir` or `.stem`, except one written `beside` another. Words are split and quoted as in Bash, and every argument is passed literally: `|`, `>` and `$` are not a shell\'s. The first word must be an executable on `PATH`, or a path to one.'
  },
  verify: {
    anchor: 'operations-and-commands',
    example: 'verify register: check_same_grid {moving} {reference}',
    text: 'Checks a job\'s inputs before its command runs. SPIT does not run it: it writes it into the `.spitdag` beside the job\'s command, and a backend runs it first. If it fails, the job does not run, and neither does any job that depends on it. It may use input ports only, `many` ones included.'
  },
  path: {
    anchor: 'paths',
    example: 'path: results/{@product}/{@entities}.txt\npath image: input/{subject}/{visit}/{run}.txt',
    text: '`path:` sets the default rule; without one, outputs go to `out/{@product}/{@entities}`. `path product:` sets one product\'s rule, and for a source, how its files are found. A `path:` line in a stage is the default for that stage\'s products. Paths are relative to the dataset root. Text in `[...]` is kept only for a product with a value for every placeholder in it.'
  },
  ext: {
    anchor: 'extensions',
    example: 'path: derivatives/{@product}/{@entities}\next: .nii.gz',
    text: 'The extension for operations that declare none, completing a default path rule. Like `path:`, it may be written at the top level or in a stage. A product\'s own `path product:` rule never takes it.'
  },
  stage: {
    anchor: 'stages',
    example: 'stage preprocess:\n    sorted = sort_lines(shard)',
    text: 'Groups the steps of one phase of a pipeline. Indent the stage\'s lines beneath it; the next line that is not indented ends it. A stage owns the products its steps assign, while operations and commands stay global. Stages nest, and SPIT orders them by the products they read. `{@stage}` in a path is the stage\'s name, one directory per level.'
  },
  use: {
    anchor: 'reuse-definitions',
    example: 'use text.spit as text\nuse shard, sort_lines from text.spit as text',
    text: 'Imports operations and source families from another `.spit` file, relative to this one. An operation brings its `command`, and a source its path rule; steps are not imported.'
  },
  'use as': {
    anchor: 'reuse-definitions',
    example: 'use text.spit as text\nsorted = text::sort_lines(text::shard)',
    text: 'Gives every name a `use` line imports a prefix, as in `text::shard`. Without it, the names come into this file\'s scope.'
  },
  'use from': {
    anchor: 'reuse-definitions',
    example: 'use shard, sort_lines from text.spit',
    text: 'Names the file a `use` line imports only the listed definitions from.'
  },
  dimensions: {
    anchor: 'dimension-order',
    example: 'dimensions [model, config, seed]',
    text: 'Declares the pipeline\'s dimension order, once at the top level, for a product holding two dimensions that no source orders. It names every dimension once, and each source lists its dimensions in that order. The order sorts a `many` input\'s artifacts and writes `{@entities}`.'
  },
  sidecars: {
    anchor: 'sidecar-files',
    example: 'sidecars photo [site, shot]: site-{site}/shot-{shot}\n    source raw_photo : Image .raw\n    source photo_json .json',
    text: 'Declares sources whose files share dimensions and a path stem, and differ only by extension. Each indented member is an ordinary source whose path is the stem and its extension. `spit inputs` warns where it finds some of a group\'s files and not the others.'
  },
  many: {
    anchor: 'operations-and-commands',
    example: 'operation mean(images: many Image) -> Image\naverage = mean(processed @ vary(run))',
    text: 'A port that collects several artifacts into one job. Each call names the dimensions it collects with `@ vary(...)`. Its placeholder becomes one quoted argument per artifact, in the pipeline\'s dimension order, and must be a whole argument. An operation takes at most one `many` input.'
  },
  beside: {
    anchor: 'files-a-tool-writes-beside-another',
    example: 'operation strip(t1: Image) -> (brain: Image .nii.gz, mask: Image "_mask.nii.gz" beside brain)',
    text: 'An output the tool writes next to another without being told where. Its path is its sibling\'s, without the sibling\'s extension, then the suffix: beside `sub-01_brain.nii.gz`, `mask` is `sub-01_brain_mask.nii.gz`. It may be left out of the command, and has no path rule of its own.'
  },
  vary: {
    anchor: 'operations-and-commands',
    example: 'average = mean(processed @ vary(run))',
    text: 'Collects a `many` input over the named dimensions, which leave the output\'s identity. One `vary(...)` may name several; the collection follows the pipeline\'s dimension order whatever order it lists them in.'
  },
  each: {
    anchor: 'operations-and-commands',
    example: 'forecast = predict(reading, model @ each(scenario), parameters)',
    text: 'Broadcasts an input over a dimension the driving input lacks: the step runs once for each of the input\'s values, and its outputs gain that dimension. The reverse of `vary`. Only one input may broadcast a given dimension.'
  },
  where: {
    anchor: 'operations-and-commands',
    example: 'calibrated = calibrate(reading, calibration @ where(revision=2))',
    text: 'Keeps the artifacts with that value and takes the dimension out of matching, so a family with an extra dimension can join a less specific input.'
  },
  same: {
    anchor: 'operations-and-commands',
    example: 'anomaly = compare(calibrated, reference @ same(station))',
    text: 'Matches on the named dimensions alone. The input\'s other dimensions must then leave exactly one artifact for each job.'
  },
  min: {
    anchor: 'operations-and-commands',
    example: 'operation summarise(days: many Series) -> Summary @ min(2)',
    text: 'Rejects a group whose `many` input has fewer artifacts than the minimum. With `dag --partial`, it counts what is left once incomplete members are removed.'
  },
  pipeline: {
    anchor: 'recipes',
    example: 'pipeline analysis.spit',
    text: 'The first line of a `.spitin` recipe: the pipeline it serves, relative to the recipe\'s folder. `spit check`, `spit inputs` and `spit dag` read the pipeline from it.'
  },
  root: {
    anchor: 'recipes',
    example: 'root data',
    text: 'The dataset root, the folder paths are relative to. In a recipe it is relative to the recipe\'s folder, which is the root without the line; in a `.spitout` that `spit inputs -o` writes, it is relative to the `.spitout`\'s folder. `--root` overrides either.'
  },
  discover: {
    anchor: 'discover-contexts-from-directories',
    example: 'discover sessions: [sub, ses] from dirs data/sub-{sub}/ses-{ses}',
    text: 'Finds a dataset\'s contexts from its directories: each matching directory, even an empty one, gives one binding, and only those found on disk are used. `sessions` names the rule, which `require` and `drop` can count. A source whose dimensions fit within the rule\'s expects a file for each binding.'
  },
  'discover from': {
    anchor: 'discover-contexts-from-directories',
    example: 'discover sessions: [sub, ses] from dirs data/sub-{sub}/ses-{ses}',
    text: 'The directory pattern a `discover` rule matches, relative to the dataset root. It uses every declared dimension and no other placeholder.'
  },
  require: {
    anchor: 'constraints',
    example: 'require image count>=2 per [subject, visit]\nrequire image run=1,2 per [subject, visit]',
    text: 'Stops the run if any group fails, checked against what `exclude` and `drop` leave. A rule counts artifacts or requires particular values in each group. A rule that finds no group at all is an error.'
  },
  per: {
    anchor: 'constraints',
    example: 'require image count=1 per [subject, visit]',
    text: 'The dimensions a `require` rule groups by. Each group is checked on its own.'
  },
  count: {
    anchor: 'constraints',
    example: 'require image count>=2 per [subject, visit]\ndrop [sub] where sessions count<2',
    text: 'How many artifacts of a source, or contexts of a discovery, each group holds, compared with `=`, `!=`, `>=`, `<=`, `>` or `<`.'
  },
  drop: {
    anchor: 'drop-groups-that-fail-a-criterion',
    example: 'drop [sub] where sessions count<2\ndrop [sub, ses] where bold missing run=1,2',
    text: 'Removes every group that meets its condition, with every artifact and discovered context in it. Judged after every `exclude` and before every `require`, whatever order the rules are written in. A rule that would remove every group is an error. Each removed group is reported and recorded in the `.spitout`.'
  },
  'drop where': {
    anchor: 'drop-groups-that-fail-a-criterion',
    example: 'drop [sub, ses] where t1w count=0',
    text: 'Introduces a `drop` rule\'s condition: the source or discovery rule to count, then a `count`, `missing` values or `has` values.'
  },
  missing: {
    anchor: 'drop-groups-that-fail-a-criterion',
    example: 'drop [sub, ses] where bold missing run=1,2',
    text: 'Removes each group without one of the values: here, a session without a run 1 or without a run 2.'
  },
  has: {
    anchor: 'drop-groups-that-fail-a-criterion',
    example: 'drop [sub, ses] where bold has run=3',
    text: 'Removes each group with one of the values: here, a session with a run 3.'
  },
  exclude: {
    anchor: 'exclude-named-artifacts',
    example: 'exclude bold[sub=02,ses=02,run=3]    # corrupted\nexclude [sub=07]                     # withdrew consent',
    text: 'Removes artifacts by name, while their files stay where they are. A source with all its dimensions names one artifact; values alone name a group of every source; a source with some dimensions names part of that source. A comment on the line is kept as the reason. Applies before every other rule, and an exclude that matches nothing is an error.'
  },
  'exclude from': {
    anchor: 'exclude-named-artifacts',
    example: 'exclude from qc/excluded.csv',
    text: 'Reads `exclude` rules from a CSV file, relative to the recipe\'s folder, one rule per row. The header names the columns: `product` and `reason` are optional, and every other column is a dimension. An empty cell leaves its column out.'
  },
  '@product': {
    anchor: 'paths',
    example: 'path: results/{@product}/{@entities}.txt',
    text: 'The product\'s name in a path, as `aligned`. An imported `alias::name` becomes `alias.name`.'
  },
  '@entities': {
    anchor: 'paths',
    example: 'path: results/{@product}/{@entities}.txt',
    text: 'Every dimension as `dim=value`, in the pipeline\'s dimension order, joined by `__`, as `subject=A__run=2`; `global` for a product with no dimensions.'
  },
  '@stage': {
    anchor: 'paths',
    example: 'path: {@stage}/{@product}/{@entities}.txt',
    text: 'The stage whose block holds the step, one directory per level, as `preprocess/align`. An error for a product made outside every stage, unless it is in an optional `[...]` group.'
  },
  '@labels': {
    anchor: 'paths',
    example: 'path: derivatives/sub-{sub}[/ses-{ses}]/{@labels}_{@product}',
    text: 'Every dimension as `key-value`, in the pipeline\'s dimension order, joined by `_`, as `subject-A_run-2`. SPIT warns if a value contains `-`, since a BIDS reader cannot recover it from the file name.'
  },
  output: {
    anchor: 'operations-and-commands',
    example: 'command process: process_tool --in {image} --out {output}',
    text: 'The path of the operation\'s single unnamed output, which the command must use. `output` cannot name an input port.'
  },
  '.dir': {
    anchor: 'operations-and-commands',
    example: 'command convert: dcm2niix -o {image.dir} -f {image.stem} {dicom}',
    text: 'The folder of an output\'s file, for a tool that takes a folder and a name: `.` for a file at the dataset root. Counts as using the output.'
  },
  '.stem': {
    anchor: 'operations-and-commands',
    example: 'command convert: dcm2niix -o {image.dir} -f {image.stem} {dicom}',
    text: 'An output\'s file name without its extension, for a tool that adds the extension itself. Needs the output to declare its extension. Counts as using the output.'
  },
  'sources:': {
    anchor: 'inputs',
    example: 'sources:\n    image[subject=A,visit=1,run=1]',
    text: 'A `.spitout`\'s settled source identities. A record names no file of its own: its source\'s path rule gives it.'
  },
  'source_paths:': {
    anchor: 'inputs',
    example: 'source_paths:\n    image: data/sub-{sub}/image.nii.gz',
    text: 'A source path rule a recipe declares, written once in the `.spitout`, so the DAG can use it without the recipe.'
  },
  'contexts:': {
    anchor: 'inputs',
    example: 'contexts sessions:\n    [sub=01,ses=01]:\n        t1w',
    text: 'Groups named even when one of their inputs is absent. `contexts sessions:` holds the bindings the `discover sessions` rule found, with the source identities under each.'
  },
  'removed:': {
    anchor: 'inputs',
    example: 'removed:\n    [sub=07]\n        rule: drop [sub] where sessions count<2\n        at: line 6\n        found: 1',
    text: 'What the recipe\'s `exclude` and `drop` rules removed, each with its rule, line, count found and reason. A record, not a rule: the records above already leave these out, and `dag` copies it into the `.spitdag`.'
  }
};

// The words that start a statement when followed by a space, as SPIT's
// parser has them; `path` and `ext:` are matched apart, as there.
const STATEMENTS = ['use', 'source', 'discover', 'operation', 'command', 'verify', 'require', 'drop', 'exclude', 'stage', 'dimensions', 'sidecars', 'pipeline', 'root'];
// A step's output may have one of these names: `stage = ...`.
const NAMEABLE = ['stage', 'dimensions', 'sidecars', 'pipeline', 'root'];
const SELECTORS = ['vary', 'each', 'where', 'same', 'min'];

// The statement keyword a trimmed line starts with, or null.
function statementOf(line) {
  if (/^path[ :]/.test(line)) return 'path';
  if (line.startsWith('ext:')) return line.includes('=') ? null : 'ext';
  const word = /^([a-z_]+) /.exec(line)?.[1];
  if (!word || !STATEMENTS.includes(word)) return null;
  if (NAMEABLE.includes(word) && line.includes('=')) return null;
  return word;
}

// The placeholder `{...}` holding `character`, with where its name starts,
// or null; `{{` and `}}` are literal braces.
function placeholderAt(code, character) {
  const pattern = /\{\{|\}\}|\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(code))) {
    if (match.index > character) break;
    if (match[1] !== undefined && character < match.index + match[0].length) {
      return { name: match[1], start: match.index + 1 };
    }
  }
  return null;
}

// The built-in at `character` of `lineText`, as a key of BUILTINS, with its
// span on the line, or null. `stripComment` is SPIT's own comment rule.
function builtinAt(lineText, character, stripComment) {
  const code = stripComment(lineText);
  if (character >= code.length) return null;
  const indent = /^\s*/.exec(code)[0].length;
  const line = code.slice(indent).trimEnd();
  const statement = statementOf(line);

  const placeholder = placeholderAt(code, character);
  if (placeholder) {
    const { name, start } = placeholder;
    const span = (from, to) => ({ start: start + from, end: start + to });
    if (/^@(?:product|entities|stage|labels)$/.test(name)) return { key: name, ...span(0, name.length) };
    if (statement === 'command' || statement === 'verify') {
      if (name === 'output') return { key: 'output', ...span(0, name.length) };
      const part = /^[A-Za-z_][A-Za-z0-9_]*(\.(?:dir|stem))$/.exec(name);
      const dot = name.length - (part?.[1].length ?? 0);
      if (part && character >= start + dot) return { key: part[1], ...span(dot, name.length) };
    }
    return null;
  }

  // A `.spitout`'s section headers.
  const header = /^(sources|source_paths|contexts|removed)\b(?:\s+[A-Za-z_][A-Za-z0-9_:]*)?:$/.exec(line);
  if (header && character < indent + header[1].length && character >= indent) {
    return { key: `${header[1]}:`, start: indent, end: indent + header[1].length };
  }

  let word = null;
  const words = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match;
  while ((match = words.exec(code))) {
    if (match.index <= character && character < match.index + match[0].length) {
      word = { text: match[0], start: match.index, end: match.index + match[0].length };
      break;
    }
  }
  if (!word) return null;
  const found = key => ({ key, start: word.start, end: word.end });
  const before = code.slice(0, word.start);
  const after = code.slice(word.end);

  if (word.start === indent && statement === word.text) return found(word.text);
  if (word.start === indent && statement === 'path' && word.text === 'path') return found('path');
  if (word.start === indent && statement === 'ext' && word.text === 'ext') return found('ext');

  // A selector: `@ vary(run)`, or an operation's `@ min(2)`.
  if (SELECTORS.includes(word.text) && /@\s*$/.test(before) && /^\s*\(/.test(after)) return found(word.text);

  if (statement === 'operation') {
    if (word.text === 'many' && /:\s*$/.test(before)) return found('many');
    if (word.text === 'beside' && before.includes('->') && /\s$/.test(before)) return found('beside');
  }
  if (statement === 'use' && (word.text === 'as' || word.text === 'from')) return found(`use ${word.text}`);
  if (statement === 'discover' && (word.text === 'from' || (word.text === 'dirs' && /\bfrom\s+$/.test(before)))) {
    return found('discover from');
  }
  if (statement === 'exclude' && word.text === 'from' && /^\s*exclude\s+$/.test(before)) return found('exclude from');
  if (statement === 'require' || statement === 'drop') {
    if (word.text === 'count' && /^\s*(?:=|!=|>=|<=|>|<)/.test(after)) return found('count');
    if (statement === 'require' && word.text === 'per' && /^\s*\[/.test(after)) return found('per');
    if (statement === 'drop' && word.text === 'where' && /\]\s*$/.test(before)) return found('drop where');
    if (statement === 'drop' && (word.text === 'missing' || word.text === 'has') && /\bwhere\b/.test(before)) {
      return found(word.text);
    }
  }
  return null;
}

// The hover's Markdown: an example, what it does, and where to read more.
function builtinMarkdown(key) {
  const entry = BUILTINS[key];
  return `\`\`\`spit\n${entry.example}\n\`\`\`\n\n${entry.text}\n\n[Language reference](${REFERENCE}#${entry.anchor})`;
}

module.exports = { BUILTINS, REFERENCE, builtinAt, builtinMarkdown };
