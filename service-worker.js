'use strict';
importScripts('./delivery-config.js');

const config = globalThis.VECTORCRAFT_DELIVERY;
const wasmUrl = new URL(config.wasmPath, self.registration.scope).href;
const cachePrefix = `vectorcraft-mirror-assets:${self.registration.scope}:`;
const cacheName = cachePrefix + config.wasmSha256;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  try {
    for (const name of await caches.keys()) if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
  } catch { await report({ state: 'cache-unavailable' }); }
  await self.clients.claim();
})()));

async function report(detail) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if (client.url.startsWith(self.registration.scope)) client.postMessage({ type: 'vectorcraft-download', ...detail });
  }
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheVerified(blob) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(wasmUrl, new Response(blob, { headers: { 'Content-Type': 'application/wasm' } }));
    await report({ state: 'cached' });
  } catch {
    await report({ state: 'cache-unavailable' });
  }
}

// Hold EOF until SHA-256 passes: compilation can stream; instantiation cannot finish on unverified bytes.
function verifiedResponse(source, transport, finish) {
  const reader = source.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) {
          received += value.byteLength;
          if (received > config.wasmBytes) throw new Error('Application exceeds expected byte count');
          chunks.push(value);
          if (transport.source === 'network' && performance.now() - lastReport >= config.uiPollMs) {
            await report({ state: 'receiving', received, total: config.wasmBytes, source: 'network' });
            lastReport = performance.now();
          }
          controller.enqueue(value);
          return;
        }
        const blob = new Blob(chunks, { type: 'application/wasm' });
        if (received !== config.wasmBytes || await sha256(await blob.arrayBuffer()) !== config.wasmSha256) throw new Error('Application integrity check failed');
        await report({ state: 'complete', received, total: config.wasmBytes, source: transport.source, verified: true });
        controller.close();
        void cacheVerified(blob).finally(finish);
      } catch (error) {
        transport.cancel();
        void reader.cancel(error).catch(() => {});
        controller.error(error);
        try { await report({ state: 'failed', message: error.message }); } finally { finish(); }
      }
    },
    cancel(reason) {
      transport.cancel();
      finish();
      return reader.cancel(reason);
    },
  }), { headers: { 'Content-Type': 'application/wasm' } });
}

async function compressedParts() {
  const manifestUrl = new URL(config.partsManifest, self.registration.scope);
  const response = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Download manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.encoding !== 'gzip' || manifest.wasmBytes !== config.wasmBytes || manifest.wasmSha256 !== config.wasmSha256 || !Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error('Invalid download manifest');
  const directory = new URL('./', manifestUrl).href;
  if (manifest.parts.some(part => !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > config.partBytes || !/^[a-f0-9]{64}$/.test(part.sha256) || typeof part.path !== 'string' || new URL(part.path, manifestUrl).href !== directory + part.path || part.path.includes('/')) || manifest.parts.reduce((sum, part) => sum + part.bytes, 0) !== manifest.compressedBytes) throw new Error('Invalid download parts');
  const cancellation = new AbortController();
  const progress = new Array(manifest.parts.length).fill(0);
  let lastReport = 0;
  async function fetchPart(index) {
    const part = manifest.parts[index];
    for (let attempt = 1; attempt <= config.partAttempts; attempt++) {
      const abort = new AbortController();
      const cancel = () => abort.abort(cancellation.signal.reason);
      cancellation.signal.addEventListener('abort', cancel, { once: true });
      const deadline = setTimeout(() => abort.abort(new Error('Part download timed out')), config.partTimeoutMs);
      progress[index] = 0;
      try {
        if (cancellation.signal.aborted) throw cancellation.signal.reason;
        const result = await fetch(new URL(part.path, manifestUrl), { signal: abort.signal });
        if (!result.ok || !result.body) throw new Error(`HTTP ${result.status}`);
        const reader = result.body.getReader();
        const chunks = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            progress[index] += value.byteLength;
            if (progress[index] > part.bytes) throw new Error('Part exceeds expected byte count');
            chunks.push(value);
            if (performance.now() - lastReport >= config.uiPollMs) {
              await report({ state: 'receiving', received: progress.reduce((sum, bytes) => sum + bytes, 0), total: manifest.compressedBytes, source: 'parts' });
              lastReport = performance.now();
            }
          }
        } finally { void reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        if (bytes.byteLength !== part.bytes || await sha256(bytes) !== part.sha256) throw new Error('Part integrity check failed');
        return bytes;
      } catch (error) {
        if (cancellation.signal.aborted || attempt === config.partAttempts) throw new Error(`Part ${index + 1}: ${error.message}`);
        await report({ state: 'retrying', part: index + 1, attempt: attempt + 1 });
      } finally {
        clearTimeout(deadline);
        cancellation.signal.removeEventListener('abort', cancel);
      }
    }
  }
  const pending = new Map();
  let launched = 0;
  let next = 0;
  function fill() {
    while (launched < manifest.parts.length && pending.size < config.downloadConcurrency) {
      const index = launched++;
      pending.set(index, fetchPart(index).then(bytes => ({ bytes }), error => ({ error })));
    }
  }
  fill();
  const ordered = new ReadableStream({
    async pull(controller) {
      if (next === manifest.parts.length) { controller.close(); return; }
      const result = await pending.get(next);
      if (result.error) { cancellation.abort(result.error); controller.error(result.error); return; }
      pending.delete(next++);
      controller.enqueue(result.bytes);
      fill();
    },
    cancel(reason) { cancellation.abort(reason); },
  });
  return { response: new Response(ordered.pipeThrough(new DecompressionStream('gzip'))), source: 'parts', cancel: () => cancellation.abort(new Error('Download cancelled')) };
}

async function respond(request, finish) {
  try {
    try {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(wasmUrl);
      if (cached) {
        await report({ state: 'complete', received: config.wasmBytes, total: config.wasmBytes, source: 'cache', verified: true });
        finish();
        return cached;
      }
    } catch { await report({ state: 'cache-unavailable' }); }
    let transport;
    if (config.partsManifest && typeof DecompressionStream === 'function') {
      transport = await compressedParts();
    } else {
      await report({ state: 'single-file', reason: config.partsManifest ? 'decompression-unavailable' : 'unpackaged-preview' });
      const response = await fetch(request);
      if (!response.ok || !response.body) throw new Error(`Application download: HTTP ${response.status}`);
      transport = { response, source: 'network', cancel: () => {} };
    }
    return verifiedResponse(transport.response, transport, finish);
  } catch (error) {
    try { await report({ state: 'failed', message: error.message }); } finally { finish(); }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url !== wasmUrl) return;
  let finish;
  event.waitUntil(new Promise(resolve => { finish = resolve; }));
  event.respondWith(respond(event.request, finish));
});
