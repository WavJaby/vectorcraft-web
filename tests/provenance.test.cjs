const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vectorcraft-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.copyFileSync(path.join(__dirname, '../scripts/build-site.cjs'), path.join(root, 'scripts/build-site.cjs'));
  fs.copyFileSync(path.join(__dirname, '../scripts/upstream.cjs'), path.join(root, 'scripts/upstream.cjs'));
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]); // Wasm spec: magic + version, empty valid module.
  const html = Buffer.from('<canvas id="vectorcraft"></canvas>');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, 'app/test.wasm'), wasm);
  fs.writeFileSync(path.join(root, 'app/index.html'), html);
  const files = [{ path: 'app/test.wasm', bytes: wasm.length, sha256: hash(wasm) }, { path: 'app/index.html', bytes: html.length, sha256: hash(html) }];
  fs.writeFileSync(path.join(root, 'upstream-files.json'), JSON.stringify({ files }));
  fs.writeFileSync(path.join(root, 'delivery-config.js'), `globalThis.VECTORCRAFT_DELIVERY = ${JSON.stringify({ wasmPath: files[0].path, wasmBytes: wasm.length, wasmSha256: hash(wasm), partBytes: wasm.length, downloadConcurrency: 4 })};`);
  return { root, files, run: () => spawnSync(process.execPath, ['scripts/build-site.cjs'], { cwd: root, encoding: 'utf8' }) };
}

test('build accepts byte-exact upstream files', t => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
});

test('build rejects changed upstream HTML even when Wasm is unchanged', t => {
  const { root, run } = fixture(t);
  fs.appendFileSync(path.join(root, 'app/index.html'), '\n');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Official release file changed: app\/index.html/);
});

test('build rejects release manifest paths outside app', t => {
  const { root, files, run } = fixture(t);
  files.push({ path: '../outside', bytes: 0, sha256: '' });
  fs.writeFileSync(path.join(root, 'upstream-files.json'), JSON.stringify({ files }));
  assert.match(run().stderr, /Upstream manifest path must name a release file inside app/);
});
