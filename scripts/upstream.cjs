'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// ZIP32 central directory; reject unsupported formats and traversal before any extraction.
function unzip(zip) {
  let end = zip.length - 22;
  const earliest = Math.max(0, end - 65535); // ZIP specification: maximum EOCD comment length.
  while (end >= earliest && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < earliest || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error('Expected a single-disk ZIP32 archive');
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = zip.readUInt16LE(pos + 10);
    const packed = zip.readUInt32LE(pos + 20);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString();
    const local = zip.readUInt32LE(pos + 42);
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || name.includes(':') || entries.has(name)) throw new Error(`Unsafe ZIP path: ${name}`);
    if (zip.readUInt16LE(pos + 8) & 1 || ![0, 8].includes(method)) throw new Error('Encrypted or unsupported ZIP entry');
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    const bytes = method === 8 ? zlib.inflateRawSync(data) : data;
    if (bytes.length !== size) throw new Error(`ZIP size mismatch: ${name}`);
    if (!name.endsWith('/')) entries.set(name, bytes);
    pos += 46 + nameLength + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32);
  }
  return entries;
}

async function archiveBytes(source, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('A pinned SHA-256 is required');
  let bytes;
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Upstream download: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else bytes = fs.readFileSync(source);
  if (hash(bytes) !== expectedHash) throw new Error('Upstream archive SHA-256 mismatch');
  return bytes;
}

async function restoreWasm(root, manifest, source = manifest.archive) {
  const entry = manifest.files.find(file => file.path.endsWith('.wasm'));
  if (!entry || !/^app\/[^/\\]+\.wasm$/.test(entry.path)) throw new Error('Expected one pinned app/ Wasm');
  const target = path.join(root, entry.path);
  if (fs.existsSync(target)) {
    if (hash(fs.readFileSync(target)) !== entry.sha256) throw new Error('Local Wasm differs from the pinned upstream');
    return;
  }
  const entries = unzip(await archiveBytes(source, manifest.archiveSha256));
  const candidates = [...entries].filter(([name]) => path.posix.basename(name) === path.posix.basename(entry.path));
  if (candidates.length !== 1) throw new Error('Upstream archive must contain exactly one matching Wasm');
  const bytes = candidates[0][1];
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error('Extracted Wasm differs from the pinned upstream');
  fs.writeFileSync(target, bytes);
}
module.exports = {hash, unzip, archiveBytes, restoreWasm};
