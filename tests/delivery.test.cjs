const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
const original = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]); // Core Wasm spec: magic + version, valid empty module.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scope = 'https://example.test/vectorcraft-web/';

function setup(mode = 'parts') {
  const compressed = gzipSync(original);
  const partBytes = original.length; // Small fixture chunks force multiple downloads without a large binary.
  const parts = [];
  for (let offset = 0; offset < compressed.length; offset += partBytes) parts.push(compressed.subarray(offset, offset + partBytes));
  const config = { wasmPath: 'app/test.wasm', wasmBytes: original.length, wasmSha256: hash(original), partsManifest: 'delivery/test/manifest.json', partBytes, downloadConcurrency: 2, partAttempts: 2, partTimeoutMs: 1000, uiPollMs: 0 };
  // Timeout fixture: schedule the timeout immediately; normal cases use a 1 s deadlock guard.
  if (mode === 'timeout') config.partTimeoutMs = 0;
  if (mode === 'preview' || mode === 'raw-truncated' || mode === 'raw-oversized' || mode === 'offline') config.partsManifest = null;
  const manifest = { encoding: 'gzip', wasmBytes: original.length, wasmSha256: hash(original), compressedBytes: compressed.length, parts: parts.map((part, index) => ({ path: `part-${index}.bin`, bytes: part.length, sha256: hash(part) })) };
  if (mode === 'manifest-invalid') manifest.wasmSha256 = 'bad-release';
  if (mode === 'part-metadata-invalid') manifest.parts[0].path = '../outside.bin';
  if (mode === 'full-hash-mismatch') config.wasmSha256 = manifest.wasmSha256 = hash(Buffer.from('Different pinned artifact'));
  if (mode === 'bad-gzip') { parts[0] = Buffer.alloc(parts[0].length); manifest.parts[0].sha256 = hash(parts[0]); }
  const messages = [];
  const requests = [];
  const attempts = new Map();
  const writes = [];
  const removed = [];
  const handlers = {};
  let active = 0;
  let peak = 0;
  let claimed = false;
  const cache = {
    match: async () => mode === 'cache-hit' ? new Response(original, { headers: { 'Content-Type': 'application/wasm' } }) : undefined,
    put: async (url, response) => {
      if (mode === 'quota') throw new Error('QuotaExceededError');
      writes.push({ url, bytes: Buffer.from(await response.arrayBuffer()) });
    },
  };
  const context = vm.createContext({
    URL, Response, Blob, ReadableStream, AbortController, performance, setTimeout, clearTimeout, crypto: webcrypto,
    DecompressionStream: mode === 'no-decompression' ? undefined : DecompressionStream,
    VECTORCRAFT_DELIVERY: config, importScripts: () => {},
    self: {
      registration: { scope }, addEventListener: (name, handler) => { handlers[name] = handler; }, skipWaiting: async () => {},
      clients: { claim: async () => { claimed = true; }, matchAll: async () => [{ url: scope, postMessage: message => messages.push(message) }] },
    },
    caches: {
      keys: async () => { if (mode === 'storage-blocked') throw new Error('Storage blocked'); return [`vectorcraft-mirror-assets:${scope}:old`, 'unrelated-app']; },
      delete: async name => { removed.push(name); },
      open: async () => { if (mode === 'storage-blocked') throw new Error('Storage blocked'); return cache; },
    },
    fetch: async (input, options = {}) => {
      const url = String(input.url || input);
      requests.push(url);
      if (url.endsWith('manifest.json')) return mode === 'manifest-missing' ? new Response('missing', { status: 404 }) : Response.json(manifest);
      if (url.endsWith('test.wasm')) {
        if (mode === 'offline') throw new Error('Offline');
        return new Response(mode === 'raw-truncated' ? original.subarray(1) : mode === 'raw-oversized' ? Buffer.concat([original, original]) : original);
      }
      const index = Number(/part-(\d+)\.bin$/.exec(url)[1]);
      const attempt = (attempts.get(index) || 0) + 1;
      attempts.set(index, attempt);
      if (mode === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (options.signal.aborted) throw options.signal.reason;
      if (index === 0 && (mode === 'missing' || mode === 'transient' && attempt === 1)) return new Response('unavailable', { status: mode === 'missing' ? 404 : 503 });
      let bytes = parts[index];
      if (index === 0 && mode === 'truncated') bytes = bytes.subarray(1);
      if (index === 0 && mode === 'corrupt-once' && attempt === 1) bytes = Buffer.alloc(bytes.length);
      return new Response(bytes);
    },
  });
  vm.runInContext(source, context);
  async function lifecycle(name) {
    let done;
    handlers[name]({ waitUntil: promise => { done = promise; } });
    await done;
  }
  async function request() {
    let response;
    let lifetime;
    handlers.fetch({ request: new Request(scope + config.wasmPath), respondWith: promise => { response = promise; }, waitUntil: promise => { lifetime = promise; } });
    try {
      const result = await response;
      const [bytes, compiled] = await Promise.all([result.clone().arrayBuffer(), WebAssembly.compileStreaming(result)]);
      assert(compiled instanceof WebAssembly.Module);
      return Buffer.from(bytes);
    } finally { await lifetime; }
  }
  return { request, lifecycle, messages, requests, attempts, writes, removed, config, parts, peak: () => peak, claimed: () => claimed, handlers };
}

for (const mode of ['parts', 'corrupt-once', 'transient', 'quota', 'storage-blocked', 'preview', 'no-decompression', 'cache-hit']) {
  test(`verified delivery: ${mode}`, async () => {
    const probe = setup(mode);
    assert.deepEqual(await probe.request(), original);
    assert(probe.messages.some(message => message.state === 'complete' && message.verified));
    if (mode === 'cache-hit') assert.equal(probe.requests.length, 0);
    else if (mode === 'preview' || mode === 'no-decompression') assert(probe.messages.some(message => message.state === 'single-file'));
    else {
      assert(!probe.requests.some(url => url.endsWith('test.wasm')));
      assert(probe.peak() <= probe.config.downloadConcurrency);
      assert(probe.peak() > 1, 'Probe must actually exercise concurrent downloads');
    }
    if (mode === 'corrupt-once' || mode === 'transient') {
      assert.equal(probe.attempts.get(0), probe.config.partAttempts);
      assert(probe.messages.some(message => message.state === 'retrying'));
    }
    if (mode === 'quota' || mode === 'storage-blocked') {
      assert(probe.messages.some(message => message.state === 'cache-unavailable'));
      assert.equal(probe.writes.length, 0);
    } else if (mode !== 'cache-hit') assert.deepEqual(probe.writes[0].bytes, original);
  });
}

for (const mode of ['missing', 'truncated', 'manifest-invalid', 'part-metadata-invalid', 'manifest-missing', 'full-hash-mismatch', 'bad-gzip', 'raw-truncated', 'raw-oversized', 'offline', 'timeout']) {
  test(`failed delivery blocks compilation/cache: ${mode}`, async () => {
    const probe = setup(mode);
    await assert.rejects(probe.request());
    assert.equal(probe.writes.length, 0);
    assert(!probe.messages.some(message => message.state === 'complete'));
    assert(probe.messages.some(message => message.state === 'failed'));
    if (mode === 'missing' || mode === 'truncated' || mode === 'timeout') assert.equal(probe.attempts.get(0), probe.config.partAttempts);
  });
}

test('worker activation retires only its own old application cache', async () => {
  const probe = setup();
  await probe.lifecycle('install');
  await probe.lifecycle('activate');
  assert.equal(probe.claimed(), true);
  assert.deepEqual(probe.removed, [`vectorcraft-mirror-assets:${scope}:old`]);
});

test('blocked cache does not prevent worker activation', async () => {
  const probe = setup('storage-blocked');
  await probe.lifecycle('activate');
  assert.equal(probe.claimed(), true);
  assert(probe.messages.some(message => message.state === 'cache-unavailable'));
});

test('other requests pass through without interception', () => {
  const probe = setup();
  for (const request of [new Request(scope + 'index.html'), new Request(scope + probe.config.wasmPath, { method: 'POST' })]) {
    probe.handlers.fetch({ request, respondWith: () => assert.fail('Unexpected interception') });
  }
});

test('built package reproduces the pinned official artifact', { skip: !fs.existsSync(path.join(__dirname, '..', '_site')) }, () => {
  const root = path.join(__dirname, '..', '_site');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'delivery-config.js'), 'utf8'), context);
  const config = context.VECTORCRAFT_DELIVERY;
  const filename = path.join(root, config.partsManifest);
  const manifest = JSON.parse(fs.readFileSync(filename));
  const chunks = manifest.parts.map(part => {
    const bytes = fs.readFileSync(path.join(path.dirname(filename), part.path));
    assert.equal(hash(bytes), part.sha256);
    assert.equal(bytes.length, part.bytes);
    return bytes;
  });
  const decoded = require('node:zlib').gunzipSync(Buffer.concat(chunks));
  assert.equal(hash(decoded), config.wasmSha256);
  assert.deepEqual(decoded, fs.readFileSync(path.join(root, config.wasmPath)));
});
