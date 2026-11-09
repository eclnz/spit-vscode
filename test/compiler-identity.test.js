const assert = require('node:assert/strict');
const test = require('node:test');
const { newerSource, parseCompilerIdentity, resolveCommand } = require('../compiler-identity');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('identifies SPIT compiler and compares the minimum language version', () => {
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 0.3.0\n', '0.3.0'), { version: '0.3.0', incompatible: false });
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 0.2.2\n', '0.3.0'), { version: '0.2.2', incompatible: true });
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 0.3.1\n', '0.3.0'), { version: '0.3.1', incompatible: false });
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 1.0.0\n', '0.3.0'), { version: '1.0.0', incompatible: false });
});

test('rejects unrelated or unidentifiable executables, including old ambiguous versions', () => {
  assert.equal(parseCompilerIdentity('spit 0.3.0\n', '0.3.0'), null);
  assert.equal(parseCompilerIdentity('unrelated spit 0.3.0\n', '0.3.0'), null);
  assert.equal(parseCompilerIdentity('', '0.3.0'), null);
});

test('reports the exact executable found on PATH', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-bin-test-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const name = 'test-spit-identity';
  const file = path.join(folder, name);
  fs.writeFileSync(file, '');
  assert.equal(resolveCommand(name, { PATH: folder, PATHEXT: '' }), file);
  assert.equal(resolveCommand(file), file);
  assert.equal(resolveCommand('missing-spit-compiler', { PATH: folder }), null);
});

test('names the newest source file changed after a build, and nothing when the build is newer', t => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'spit-source-test-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const build = path.join(repository, 'target', 'debug', 'spit');
  fs.mkdirSync(path.dirname(build), { recursive: true });
  fs.mkdirSync(path.join(repository, 'src', 'parser'), { recursive: true });
  const at = (file, seconds) => {
    fs.writeFileSync(file, '');
    const time = new Date(1_700_000_000_000 + seconds * 1000);
    fs.utimesSync(file, time, time);
  };
  at(build, 10);
  at(path.join(repository, 'Cargo.toml'), 5);
  at(path.join(repository, 'src', 'lib.rs'), 5);
  assert.equal(newerSource(build, repository), null);
  at(path.join(repository, 'src', 'lib.rs'), 20);
  at(path.join(repository, 'src', 'parser', 'keyword.rs'), 30);
  at(path.join(repository, 'src', 'parser', 'notes.md'), 40);
  assert.equal(newerSource(build, repository), path.join('src', 'parser', 'keyword.rs'));
  at(path.join(repository, 'Cargo.lock'), 50);
  assert.equal(newerSource(build, repository), 'Cargo.lock');
  assert.equal(newerSource(path.join(repository, 'missing'), repository), null);
});
