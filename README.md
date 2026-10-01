# SPIT for VS Code

This local extension provides syntax highlighting and shows SPIT validation errors as you edit `.spit` pipelines and `.spitin` recipes, and highlights `.spitout` inputs. Section headers (`products:`, `operations:`, `pipeline:`, `constraints:`, `commands:`, `sources:`, `contexts:`), every keyword (`require`, `skip`, `per`, `many`, `one`, `vary`, `where`, `same`, `each`, `drop`, `min`, `verify`, `use`, `from`, `as`, `source`, `operation`, `command`, `path`, `stage`, and a recipe's `pipeline` line), stage names, product and operation names, types (including `<generic>` parameters), dimension lists (`[site, device]`), `{placeholder}` text in commands and paths, quoted paths, and `#` comments are each highlighted distinctly. Placeholders SPIT defines itself are colored as built-ins, apart from the ones a pipeline names: `{product}`, `{entities}`, and `{stage}` in a path, against a dimension such as `{sub}`; and `{output}`, `{input}`, `{input1}`, and `{inputs}` in a command, against a named port such as `{dwi}`. Lines inside a `stage` fold with it, and a new line after `stage name:` is indented.

For a sectioned document (a pipeline with `products:`, `operations:`, `pipeline:`, or `commands:` headers, a recipe with a `constraints:` section, or a `.spitout` of `sources:` and `contexts:`) the extension goes further with semantic highlighting: it reads the actual declarations in the file, so a product's name is colored differently at its declaration than at each place it is used, an operation call is recognized by matching it against `operations:`, and dimension names and their values in `sources:`/`contexts:`/`constraints:` are colored by role rather than by generic pattern. The older, header-less flow style (`source name`, `operation name(...)`, `output = op(...)`) still gets full keyword and structural coloring from the syntax grammar alone.

Each file is checked on its own with `spit check <file> --json --stdin`, which reads no data. A pipeline is compiled; a `discover`, `require` or `skip` rule, or a `sources:` record, written in one is an error, since those belong in a recipe and a `.spitout`. A recipe is checked against the pipeline its `pipeline analysis.spit` line names, so a rule naming an unknown source, or counting a dimension the source lacks, is marked on the rule. Saving a pipeline rechecks the open recipes and the pipelines that import it. A `.spitout` is highlighted but not checked: finding and settling a dataset's inputs is `spit inputs`, run from the command line.

It checks unsaved text after a short pause and reports syntax errors throughout the file. Once the syntax is valid, it reports every semantic, command, and path error, each on its related line, and shows warnings for likely mistakes such as unused definitions. Each problem underlines the text it is about, such as a misspelled input or one `{placeholder}`; with an older SPIT build that reports no columns, the whole line is marked.

## Operation and product hovers

Hover over an operation or product in a `.spit` pipeline to see what the compiler knows about it. Both flow and grouped-section syntax are supported, including qualified references to imported definitions.

- Operations show their input and output ports, types, collection cardinality, aggregation contracts, and command and verification templates. At a call, the hover also shows the bound products, specialised input and output types, dimensions, and local generic type bindings.
- Products show their inferred type and dimensions, declared type, producing step, consuming steps, stage, and effective path template. The path explanation names an explicit rule, inherited stage default, pipeline default, or built-in output default. Sources without a pipeline path rule say that a recipe or inventory must supply it.

For example, `cleaned = clean(raw)` with `raw: Frame<Native>` and `clean(Frame<S>) -> CleanFrame<S>` shows `S = Native` on the call and `cleaned: CleanFrame<Native>` on the product.

Hovers use unsaved text and share the cached compiler check with diagnostics. Saving an imported pipeline refreshes dependent hovers. Independently valid declarations remain available while another line is broken; failed steps do not claim inferred types. Path templates describe artifact families; concrete dataset paths and filesystem checks are not part of these hovers. Recipes and inventories retain their existing diagnostics/highlighting without pipeline hovers.

Rebuild the sibling SPIT compiler with `cargo build`: hovers require its `check --json --stdin --hovers` support.

## Try it locally

1. Build the [SPIT compiler](https://github.com/eclnz/spit) with `cargo build`.
2. Open this repository in VS Code.
3. Choose **Run > Run Without Debugging** (Control-F5 on macOS) to launch an Extension Development Host.
4. In the new window, open a `.spit` file and edit it. Errors appear in the editor and Problems panel.

The extension uses a build at `../spit/target/debug/spit` if present, then tries `spit` on PATH. Set `spit.executablePath` in your user settings to use a build elsewhere; workspace settings cannot change it. It is the only setting. The extension stays off in folders VS Code does not trust. The SPIT executable needs `check <file> --json --stdin`, including for a `.spitin`.

A recipe's `discover sessions: [sub, ses] from dirs data/sub-{sub}/ses-{ses}` is highlighted with its name, dimensions, and placeholders, and `require sessions count>=2 per [sub]` and `skip` rules with their counts and groups. A `.spitout` names each rule's contexts in a `contexts sessions:` section, and a record may end with its file, as in `image[sub=01,ses=01]: data/sub-01/ses-01/image.nii.gz`; both are highlighted too.

## Test

Run `npm install`, then `npm test` with a sibling SPIT build. The grammar tests tokenize SPIT text with `vscode-textmate`, the engine VS Code uses, and are skipped until it is installed. Set `SPIT_TEST_EXECUTABLE` to another SPIT binary path if the repositories are elsewhere.

## Disclaimer

This extension was developed with the help of generative AI tools. I am not a JavaScript developer: most of the code and documentation was generated by AI, and I have checked it by testing its behavior rather than by expert review of the JavaScript itself. The tests cover diagnostics and highlighting, but the code may still contain errors or unidiomatic JavaScript. The extension runs the SPIT executable on the files you open, so use it only in workspaces you trust. The software is provided as is, without warranty of any kind; see the [license](LICENSE).

## License

Released under the [MIT License](LICENSE).
