const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {unzip, archiveBytes, restoreWasm} = require('../scripts/upstream.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Independent ZIP specification fixture: one stored entry, no comment or descriptor.
function zipEntry(name, bytes) {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + bytes.length, 16);
  return Buffer.concat([local, filename, bytes, central, filename, end]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-upstream-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'app'));
  const wasm = Buffer.from([0,97,115,109,1,0,0,0]); // Wasm specification: magic + version, empty module.
  const zip = zipEntry('release/test.wasm', wasm);
  const archive = path.join(root, 'release.zip');
  fs.writeFileSync(archive, zip);
  const manifest = {archive, archiveSha256: digest(zip), files: [{path:'app/test.wasm', bytes:wasm.length, sha256:digest(wasm)}]};
  return {root, wasm, zip, archive, manifest};
}
test('clean checkout restores byte-identical pinned Wasm', async t => {
  const {root, wasm, manifest} = fixture(t);
  await restoreWasm(root, manifest);
  assert.deepEqual(fs.readFileSync(path.join(root, 'app/test.wasm')), wasm);
});
test('bad archive or extracted Wasm hash refuses before writing', async t => {
  const {root, manifest} = fixture(t);
  await assert.rejects(restoreWasm(root, {...manifest, archiveSha256:'0'.repeat(64)}), /archive SHA-256 mismatch/);
  manifest.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(restoreWasm(root, manifest), /Extracted Wasm differs/);
  assert.equal(fs.existsSync(path.join(root, 'app/test.wasm')), false);
});
test('local corruption is refused and missing checksum is not trusted', async t => {
  const {root, manifest, archive} = fixture(t);
  fs.writeFileSync(path.join(root,'app/test.wasm'), 'corrupt');
  await assert.rejects(restoreWasm(root, manifest), /Local Wasm differs/);
  await assert.rejects(archiveBytes(archive, undefined), /pinned SHA-256/);
});
test('ZIP traversal and unsupported compression are refused', () => {
  assert.throws(() => unzip(zipEntry('../test.wasm', Buffer.from('x'))), /Unsafe ZIP path/);
  const bytes = zipEntry('test.wasm', Buffer.from('x'));
  const central = bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  bytes.writeUInt16LE(99, central + 10); // Not STORE (0) or DEFLATE (8).
  assert.throws(() => unzip(bytes), /unsupported ZIP entry/);
});
