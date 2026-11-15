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

// The newest file of SPIT's source in `repository`, relative to it, that
// changed after `binary` was built, or null. A build older than its source
// gives the version the source has, so the version alone cannot show that it
// misses syntax the source has since gained.
function newerSource(binary, repository) {
  let built;
  try { built = fs.statSync(binary).mtimeMs; } catch { return null; }
  let newest = null;
  let newestTime = built;
  const consider = file => {
    let modified;
    try { modified = fs.statSync(file).mtimeMs; } catch { return; }
    if (modified > newestTime) {
      newest = file;
      newestTime = modified;
    }
  };
  consider(path.join(repository, 'Cargo.toml'));
  consider(path.join(repository, 'Cargo.lock'));
  const folders = [path.join(repository, 'src')];
  while (folders.length) {
    const folder = folders.pop();
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) folders.push(file);
      else if (entry.name.endsWith('.rs')) consider(file);
    }
  }
  return newest && path.relative(repository, newest);
}

module.exports = { resolveCommand, parseCompilerIdentity, newerSource };
