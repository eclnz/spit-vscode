# SPIT for VS Code

This local extension provides syntax highlighting and shows SPIT validation errors as you edit `.spit` pipelines, `.spitin` recipes and `.spitout` inputs, and explains SPIT's words and a pipeline's names on hover. A `.spitout`'s headers (`sources:`, `source_paths:`, `contexts:`, `removed:`), every keyword (`require`, `drop`, `exclude`, `missing`, `has`, `per`, `many`, `vary`, `where`, `same`, `each`, `min`, `verify`, `use`, `from`, `as`, `source`, `dimensions`, `operation`, `command`, `path`, `ext`, `stage`, `sidecars`, a recipe's `pipeline` line, and the `root` line of a recipe or `.spitout`), stage names, product and operation names, types (including `<generic>` parameters), the extension after an operation's output type (`-> Transform .mat`) and an output written `beside` another (`mask: Image "_mask.nii.gz" beside brain`) or a `sidecars` member (`source gps : Track .gpx`), dimension lists (`[site, device]`), `{placeholder}` text in commands and paths, quoted paths, and `#` comments are each highlighted distinctly. Placeholders SPIT defines itself are colored as built-ins, apart from the ones a pipeline names: `{@product}`, `{@entities}`, `{@labels}`, and `{@stage}` in a path, against a dimension such as `{sub}`, with the brackets of an optional `[...]` group marked and `[[` and `]]` as literal brackets; and `{output}` in a command, against a named port such as `{dwi}`. An output's folder and name, `{image.dir}` and `{image.stem}`, mark `.dir` and `.stem` apart from the port. Lines inside a `stage` fold with it, and a new line after `stage name:` is indented.

Hovering shows what SPIT says about the text under the pointer. On one of SPIT's own words, such as `source`, `@ vary(...)`, `beside`, `per`, `{@entities}`, `{image.stem}` or a `.spitout`'s `sources:`, it shows an example, a summary from the [language reference](https://github.com/eclnz/spit/blob/main/docs/language-reference.md), and a link to the section. On a pipeline's product or operation, it shows what the compiler knows: its signature, inferred type and dimensions, the steps that make and use it, its command, and its path rule. Both come from the same `spit check --hovers` run as the diagnostics, so SPIT decides what each word is: a product called `each` is not the selector, and nothing in a comment is explained.

In a `.spitout`, semantic highlighting reads the records themselves, coloring each source product, and each dimension and value in its brackets, by role. Pipelines and recipes get full keyword and structural coloring from the syntax grammar.

Each file is checked on its own with `spit check <file> --json --stdin --hovers`, which reads no data. A pipeline is compiled; a `discover`, `require`, `drop` or `exclude` rule, or a `sources:` record, written in one is an error, since those belong in a recipe and a `.spitout`. A recipe is checked against the pipeline its `pipeline analysis.spit` line names, so a rule naming an unknown source, or counting a dimension the source lacks, is marked on the rule, and a `root` line naming a folder that is not there is marked with a warning. Pipeline errors found during a recipe check are marked in the pipeline file. Saving a pipeline rechecks the open recipes and the pipelines that import it. When a pipeline checks clean, each step whose output path no rule writes in full shows that path at the end of its line, such as `→ derivatives/yield_table/{@entities}.csv`, with any extension its operation or `ext:` adds, its `[...]` groups kept or dropped, and `{@labels}` written out, as `→ out/sub-{sub}/sub-{sub}_merged.img`. A step with several outputs names each one. The hints are VS Code inlay hints, so `editor.inlayHints.enabled` turns them off. A `.spitout` is checked for the syntax of its records only: finding and settling a dataset's inputs is `spit inputs`, run from the command line.

It checks unsaved text after a short pause and reports syntax errors throughout the file. Once the syntax is valid, it reports every semantic, command, and path error, each on its related line, and shows warnings for likely mistakes such as unused definitions. Each problem underlines the text it is about, such as a misspelled input or one `{placeholder}`; with an older SPIT build that reports no columns, the whole line is marked.

## Operation and product hovers

Hover over an operation or product in a `.spit` pipeline to see what the compiler knows about it, including qualified references to imported definitions.

- Operations show their input and output ports, types, collection cardinality, aggregation contracts, and command and verification templates. At a call, the hover also shows the bound products, specialised input and output types, dimensions, and local generic type bindings.
- Products show their inferred type and dimensions, declared type, producing step, consuming steps, stage, and effective path template. The path explanation names an explicit rule, inherited stage default, pipeline default, or built-in output default. Sources without a pipeline path rule say that a recipe or inventory must supply it.

For example, `cleaned = clean(raw)` with `source raw : Frame<Native> [sample]` and `operation clean(frame: Frame<S>) -> CleanFrame<S>` shows `S = Native` on the call and `cleaned: CleanFrame<Native> [sample]` on the product.

Hovers use unsaved text and share the cached compiler check with diagnostics. Saving an imported pipeline refreshes dependent hovers. Independently valid declarations remain available while another line is broken; failed steps do not claim inferred types. Path templates describe artifact families; concrete dataset paths and filesystem checks are not part of these hovers. Recipes and inventories retain their existing diagnostics/highlighting without pipeline hovers.

Rebuild the sibling SPIT compiler with `cargo build`: hovers require its `check --json --stdin --hovers` support. The hovers appear in a VS Code Extension Development Host running this version of the extension.

## Try it locally

1. Build the [SPIT compiler](https://github.com/eclnz/spit) with `cargo build`.
2. Open this repository in VS Code.
3. Choose **Run > Run Without Debugging** (Control-F5 on macOS) to launch an Extension Development Host. It opens `../spit/examples/types/typed.spit` automatically.
4. Hover over `clean` or `cleaned` on the `cleaned = clean(raw)` line. The operation hover should show `S = Native`; the product hover should show `CleanFrame<Native>`. Edit the file to see diagnostics in the editor and Problems panel.

The extension uses a build at `../spit/target/debug/spit` if present, then tries `spit` on PATH. Set `spit.executablePath` in your user settings to use a build elsewhere; workspace settings cannot change it. It is the only setting. The extension stays off in folders VS Code does not trust. The SPIT executable needs `check <file> --json --stdin --hovers`, including for a `.spitin` and a `.spitout`.

A recipe's `discover sessions: [sub, ses] from dirs data/sub-{sub}/ses-{ses}` is highlighted with its name, dimensions, and placeholders, and `require sessions count>=2 per [sub]`, `drop [sub] where sessions count<2`, and `exclude bold[run=3]` rules with their counts, groups, and values. A `.spitout` names each rule's contexts in a `contexts sessions:` section, and its records, such as `image[sub=01,ses=01]`, are highlighted too.

## Test

Run `npm install`, then `npm test` with a sibling SPIT build. The grammar tests tokenize SPIT text with `vscode-textmate`, the engine VS Code uses, and are skipped until it is installed. Set `SPIT_TEST_EXECUTABLE` to another SPIT binary path if the repositories are elsewhere.

## Disclaimer

This extension was developed with the help of generative AI tools. I am not a JavaScript developer: most of the code and documentation was generated by AI, and I have checked it by testing its behavior rather than by expert review of the JavaScript itself. The tests cover diagnostics and highlighting, but the code may still contain errors or unidiomatic JavaScript. The extension runs the SPIT executable on the files you open, so use it only in workspaces you trust. The software is provided as is, without warranty of any kind; see the [license](LICENSE).

## License

Released under the [MIT License](LICENSE).
