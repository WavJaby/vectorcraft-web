#!/usr/bin/env node
'use strict';
// Pin an explicit upstream archive; never upgrade from an unreviewed "latest" URL.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {hash, unzip, archiveBytes, restoreWasm} = require('./upstream.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
async function main() {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/update-upstream.cjs [--restore [--archive LOCAL_ZIP]] | --archive HTTPS_URL --sha256 HASH --version VERSION [--write]\nRestore downloads only the pinned Wasm into ignored app/. Update is a dry run unless --write is supplied: verifies the ZIP SHA-256, validates the supported bootstrap, replaces prior release files, updates the provenance manifest and delivery metadata. Original JS/Wasm stay byte-identical; community loader is separate. ZIP URLs must remain publicly downloadable; archive expiring CI artifacts in a GitHub Release first. No Git commits, pushes, history rewrites or deployment are performed. Review licensing/brand changes and run unit + browser lifecycle checks before deploying an update.');
    return;
  }
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'upstream-files.json')));
  if (args.includes('--restore')) {
    await restoreWasm(root, previous, option('--archive') || previous.archive);
    console.log(JSON.stringify({restored: previous.files.find(file => file.path.endsWith('.wasm')).path}));
    return;
  }
  const source = option('--archive');
  const sha = option('--sha256');
  const version = option('--version');
  if (!source || !version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Explicit --archive, --sha256 and --version required');
  if (args.includes('--write') && !/^https:\/\//.test(source)) throw new Error('Pin a public HTTPS archive URL for reproducible CI');
  const entries = unzip(await archiveBytes(source, sha));
  const indexEntries = [...entries].filter(([name]) => path.posix.basename(name) === 'index.html');
  if (indexEntries.length !== 1) throw new Error('Expected one web index.html');
  const prefix = indexEntries[0][0].slice(0, -'index.html'.length);
  const releaseFiles = [...entries].filter(([name]) => name.startsWith(prefix)).map(([name, bytes]) => [name.slice(prefix.length), bytes]);
  if (releaseFiles.some(([name]) => name.includes('/'))) throw new Error('Changed archive layout: review the upstream packaging before updating');
  const html = indexEntries[0][1].toString();
  const sandbox = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'delivery-config.js'), 'utf8'), sandbox);
  const key = Object.keys(sandbox).find(name => name.endsWith('_DELIVERY'));
  const config = {...sandbox[key]};
  if (!html.includes(`id="${config.canvasId}"`)) throw new Error('Canvas contract changed: review the loader before updating');
  const wasmFiles = releaseFiles.filter(([name]) => name.endsWith('.wasm'));
  const jsFiles = releaseFiles.filter(([name]) => name.endsWith('.js') && name !== 'audio-worklet.js');
  if (wasmFiles.length !== 1 || jsFiles.length !== 1 || (config.bootstrap === 'trunk' && !html.includes('TrunkApplicationStarted')) || (config.bootstrap === 'filmcraft' && !html.includes('await start('))) throw new Error('Bootstrap contract changed: review the loader before updating');
  const [wasmName, wasm] = wasmFiles[0];
  const revision = config.bootstrap === 'filmcraft' ? /const build = "([a-f0-9]+)"/.exec(html)?.[1] : /-([a-f0-9]+)_bg\.wasm$/.exec(wasmName)?.[1];
  if (!revision) throw new Error('Unknown upstream revision format');
  Object.assign(config, {version, revision, wasmPath: `app/${wasmName}`, wasmBytes: wasm.length, wasmSha256: hash(wasm), jsPath: `app/${jsFiles[0][0]}`, partsManifest: null});
  const files = releaseFiles.map(([name, bytes]) => ({path: `app/${name}`, bytes: bytes.length, sha256: hash(bytes)}));
  const manifest = {version, release: `v${version}`, archive: source, archiveSha256: sha, files};
  console.log(JSON.stringify({mode: args.includes('--write') ? 'write' : 'dry-run', version, archive: source, remove: previous.files.filter(file => !files.some(next => next.path === file.path)).map(file => file.path), files: files.map(file => file.path), wasmBytes: wasm.length}));
  if (!args.includes('--write')) return;
  for (const file of previous.files) if (!/^app\/[^/\\]+$/.test(file.path)) throw new Error('Unsafe prior manifest path');
  for (const [name, bytes] of releaseFiles) fs.writeFileSync(path.join(root, 'app', name), bytes);
  for (const file of previous.files) if (!files.some(next => next.path === file.path)) fs.rmSync(path.join(root, file.path), {force: true});
  fs.writeFileSync(path.join(root, 'upstream-files.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'delivery-config.js'), `'use strict';\nglobalThis.${key} = Object.freeze(${JSON.stringify(config, null, 2)});\n`);
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
