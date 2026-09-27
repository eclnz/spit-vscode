# SPIT for VS Code

This local extension provides syntax highlighting and shows SPIT validation errors as you edit `.spit` files. Section headers (`products:`, `operations:`, `pipeline:`, `constraints:`, `commands:`, `sources:`, `contexts:`), every keyword (`require`, `per`, `many`, `one`, `vary`, `where`, `same`, `drop`, `min`, `verify`, `use`, `from`, `as`, `source`, `operation`, `command`, `path`), product and operation names, types (including `<generic>` parameters), dimension lists (`[site, device]`), `{placeholder}` text in commands, quoted paths, and `#` comments are each highlighted distinctly.

For a sectioned pipeline (one with `products:`, `operations:`, `pipeline:`, `constraints:`, or `commands:` headers) the extension goes further with semantic highlighting: it reads the actual declarations in the file, so a product's name is colored differently at its declaration than at each place it is used, an operation call is recognized by matching it against `operations:`, and dimension names and their values in `sources:`/`contexts:`/`constraints:` are colored by role rather than by generic pattern. The older, header-less flow style (`source name`, `operation name(...)`, `output = op(...)`) still gets full keyword and structural coloring from the syntax grammar alone.

It checks unsaved text after a short pause and reports syntax errors throughout the file. Once the syntax is valid, it reports every semantic, command, and path error, each on its related line, and shows warnings for likely mistakes such as unused definitions. Each problem underlines the text it is about, such as a misspelled input or one `{placeholder}`; with an older SPIT build that reports no columns, the whole line is marked.
Errors in an external inventory are shown on the pipeline's first line with the inventory path and line number.

## Try it locally

1. Build the [SPIT compiler](https://github.com/eclnz/spit) with `cargo build`.
2. Open this repository in VS Code.
3. Choose **Run > Run Without Debugging** (Control-F5 on macOS) to launch an Extension Development Host.
4. In the new window, open a `.spit` file and edit it. Errors appear in the editor and Problems panel.

The extension uses a build at `../spit/target/debug/spit` if present, then tries `spit` on PATH. Set `spit.executablePath` to use a build elsewhere. The SPIT executable needs the `diagnose` command.

For a pipeline with an external inventory, the extension automatically uses a sibling file with the same stem and a `.sources` extension, unless the pipeline embeds its own inventory. Set `spit.sourcesFile` to another file path if needed; relative paths are resolved from the pipeline's folder. That file replaces an embedded inventory, which SPIT then skips and marks with a warning. If no inventory is available, SPIT still checks declarations, but it cannot validate jobs against observed inputs.

The extension reads inventory files from disk. Save changes to a `.sources` file to refresh pipeline diagnostics.

## Test

Run `npm test` with a sibling SPIT build. Set `SPIT_TEST_EXECUTABLE` to another SPIT binary path if the repositories are elsewhere.
