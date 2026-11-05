const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCompilerIdentity, resolveCommand } = require('../compiler-identity');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('identifies SPIT compiler and compares the minimum language version', () => {
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 0.2.2\n', '0.2.2'), { version: '0.2.2', incompatible: false });
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 0.2.1\n', '0.2.2'), { version: '0.2.1', incompatible: true });
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 0.3.0\n', '0.2.2'), { version: '0.3.0', incompatible: false });
  assert.deepEqual(parseCompilerIdentity('SPIT (Simple Pipeline in Text) compiler, version 1.0.0\n', '0.2.2'), { version: '1.0.0', incompatible: false });
});

test('rejects unrelated or unidentifiable executables, including old ambiguous versions', () => {
  assert.equal(parseCompilerIdentity('spit 0.2.2\n', '0.2.2'), null);
  assert.equal(parseCompilerIdentity('unrelated spit 0.2.2\n', '0.2.2'), null);
  assert.equal(parseCompilerIdentity('', '0.2.2'), null);
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
