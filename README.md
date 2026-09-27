# SPIT for VS Code

This local extension shows SPIT validation errors as you edit `.spit` files. It checks unsaved text after a short pause and reports syntax errors throughout the file. Once the syntax is valid, it reports every semantic, command, and path error, each on its related line, and shows warnings for likely mistakes such as unused definitions.
Errors in an external inventory are shown on the pipeline's first line with the inventory path and line number.

## Try it locally

1. Build the [SPIT compiler](https://github.com/eclnz/spit) with `cargo build`.
2. Open this repository in VS Code.
3. Choose **Run > Run Without Debugging** (Control-F5 on macOS) to launch an Extension Development Host.
4. In the new window, open a `.spit` file and edit it. Errors appear in the editor and Problems panel.

The extension uses a build at `../spit/target/debug/spit` if present, then tries `spit` on PATH. Set `spit.executablePath` to use a build elsewhere. The SPIT executable needs the `diagnose` command.

For a pipeline with an external inventory, the extension automatically uses a sibling file with the same stem and a `.sources` extension. An embedded inventory takes priority. Set `spit.sourcesFile` to another file path if needed; relative paths are resolved from the pipeline's folder. If no inventory is available, SPIT still checks declarations, but it cannot validate jobs against observed inputs.

The extension reads inventory files from disk. Save changes to a `.sources` file to refresh pipeline diagnostics.

## Test

Run `npm test` with a sibling SPIT build. Set `SPIT_TEST_EXECUTABLE` to another SPIT binary path if the repositories are elsewhere.
