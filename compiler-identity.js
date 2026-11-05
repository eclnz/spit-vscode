// Identifying SPIT is independent of VS Code, so the rules can be tested in Node.
const fs = require('node:fs');
const path = require('node:path');

function resolveCommand(executable, env = process.env) {
  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return fs.existsSync(executable) ? path.resolve(executable) : null;
  }
  const endings = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const folder of (env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    for (const ending of endings) {
      const candidate = path.resolve(folder, executable + ending);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function parseCompilerIdentity(output, requiredVersion) {
  const match = /^SPIT \(Simple Pipeline in Text\) compiler, version (\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\s*$/.exec(output.trim());
  if (!match) return null;
  const version = match[1];
  const actual = version.split('.').map(Number);
  const required = requiredVersion.split('.').map(Number);
  const incompatible = actual.some((part, index) =>
    actual.slice(0, index).every((value, n) => value === required[n]) && part < required[index]
  );
  return { version, incompatible };
}

module.exports = { resolveCommand, parseCompilerIdentity };
