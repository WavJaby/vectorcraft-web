#!/usr/bin/env node
'use strict';
// Build a static Pages artifact; generated chunks stay outside Git. Dry-run unless --write is supplied.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {restoreWasm} = require('./upstream.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/build-site.cjs [--output DIR] [--write]\nDry-run by default. Copies public site files, verifies pinned upstream bytes, restores ignored Wasm, and generates content-addressed gzip parts + manifest. Refuses existing output directories; use a fresh path. Node.js 24 required by CI.');
    process.exit(0);
  }
  const root = path.resolve(__dirname, '..');
  let output = path.join(root, '_site');
  let write = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--write') write = true;
    else if (args[index] === '--output' && args[index + 1]) output = path.resolve(args[++index]);
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  if (output === root || root.startsWith(output + path.sep) || output.startsWith(path.join(root, 'app') + path.sep)) throw new Error('Output must not overwrite the source or upstream app');
  const sandbox = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'delivery-config.js'), 'utf8'), sandbox);
  const config = { ...sandbox.VECTORCRAFT_DELIVERY };
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const upstream = JSON.parse(fs.readFileSync(path.join(root, 'upstream-files.json'), 'utf8'));
  if (!fs.existsSync(path.join(root, config.wasmPath)) && !write) throw new Error('Pinned Wasm is absent; --write downloads and restores it, or run update-upstream.cjs --restore first');
  if (write && fs.existsSync(output)) throw new Error('Output already exists; choose a fresh --output directory');
  await restoreWasm(root, upstream);
  if (!upstream.files.length || !upstream.files.some(file => file.path === config.wasmPath)) throw new Error('Upstream manifest must include the pinned Wasm');
  for (const file of upstream.files) {
    if (!/^app\/[^/\\]+$/.test(file.path)) throw new Error('Upstream manifest path must name a release file inside app/');
    const bytes = fs.readFileSync(path.join(root, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Official release file changed: ${file.path}`);
  }
  const wasm = fs.readFileSync(path.join(root, config.wasmPath));
  if (wasm.length !== config.wasmBytes || hash(wasm) !== config.wasmSha256) throw new Error('Official Wasm byte count or SHA-256 differs from pinned release');
  const gzip = zlib.gzipSync(wasm, { level: zlib.constants.Z_BEST_COMPRESSION });
  const packagePath = `delivery/${hash(gzip)}-${config.partBytes}`;
  const parts = [];
  for (let offset = 0; offset < gzip.length; offset += config.partBytes) {
    const bytes = gzip.subarray(offset, offset + config.partBytes);
    parts.push({ bytes, path: `part-${parts.length.toString().padStart(3, '0')}-${hash(bytes)}.bin`, sha256: hash(bytes) });
  }
  const manifest = { encoding: 'gzip', wasmBytes: wasm.length, wasmSha256: config.wasmSha256, compressedBytes: gzip.length, parts: parts.map(part => ({ path: part.path, bytes: part.bytes.length, sha256: part.sha256 })) };
  if (!zlib.gunzipSync(Buffer.concat(parts.map(part => part.bytes))).equals(wasm)) throw new Error('Packaging failed byte-exact reconstruction gate');
  // Explicit public artifact boundary; build tools, workflow files and Git metadata never reach Pages.
  const publicFiles = ['app', '.nojekyll', 'index.html', 'site.css', 'site.js', 'app-loader.js', 'hardware-check.js', 'service-worker.js', 'LICENSE-MIT', 'LICENSE-APACHE', 'README.md', 'upstream-files.json'];
  console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', output, publicFiles, rawBytes: wasm.length, compressedBytes: gzip.length, parts: parts.length, concurrency: config.downloadConcurrency, packagePath }));
  if (!write) process.exit(0);
  fs.mkdirSync(output, { recursive: true });
  for (const file of publicFiles) fs.cpSync(path.join(root, file), path.join(output, file), { recursive: true });
  const directory = path.join(output, packagePath);
  fs.mkdirSync(directory, { recursive: true });
  for (const part of parts) fs.writeFileSync(path.join(directory, part.path), part.bytes);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  config.partsManifest = `${packagePath}/manifest.json`;
  fs.writeFileSync(path.join(output, 'delivery-config.js'), `'use strict';\nglobalThis.VECTORCRAFT_DELIVERY = Object.freeze(${JSON.stringify(config, null, 2)});\n`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
