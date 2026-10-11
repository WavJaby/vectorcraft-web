const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../editor-bootstrap.js'), 'utf8');
const appId = path.basename(path.resolve(__dirname, '..')).replace('-web', '');

async function boot(mode) {
  const reports = [];
  const listeners = {};
  let poll;
  let loading = mode === 'loading-failure' ? {textContent: 'failed to start: GPUDevice failed'} : mode === 'retained-loading' ? {textContent: ''} : null;
  const handle = {state: {ready: false, error: mode === 'startup-failure' ? 'startup failed' : null, canvasSizing: {corrected: 1}}, canvas: {width: 800, height: 600, hasAttribute: () => true}};
  const parent = {document: {documentElement: {lang: 'en'}}, postMessage: (message, origin) => reports.push({message, origin})};
  parent[appId.toUpperCase() + '_DELIVERY'] = {appId, uiPollMs: 0};
  const context = vm.createContext({
    parent, location: {origin: 'https://example.test'},
    document: {documentElement: {}, addEventListener: (name, callback) => { listeners[name] = callback; }, getElementById: () => loading},
    startCanvasEditor: async () => { if (mode === 'exception') throw new Error('GPUDevice failed'); return handle; },
    setInterval: callback => { poll = callback; return 'timer'; }, clearInterval: () => { poll = null; }
  });
  await vm.runInContext('(async () => {' + source.replace(/^import .*;$/m, '') + '})()', context);
  return {reports, handle, listeners, poll: () => poll?.()};
}

test('frame reports readiness with canvas diagnostics', async () => {
  const h = await boot('ready');
  h.poll();
  assert.equal(h.handle.state.ready, true);
  assert.equal(h.reports[0].message.type, appId + '-startup');
  assert.equal(h.reports[0].message.ready, true);
  assert.equal(h.reports[0].message.canvasSizing.corrected, 1);
  assert.equal(h.reports[0].origin, 'https://example.test');
});

test('startup failures never report ready; thrown and runtime failures reach parent', async () => {
  const failed = await boot('startup-failure');
  failed.poll();
  assert.equal(failed.reports.length, 0);
  const thrown = await boot('exception');
  assert.match(thrown.reports[0].message.error, /GPUDevice failed/);
  const running = await boot('ready');
  running.listeners['editor-fatal']({detail: 'runtime trap'});
  assert.equal(running.reports.at(-1).message.error, 'runtime trap');
});

test('loading errors stop startup and retained loading follows the app readiness contract', async () => {
  if (appId === 'filmcraft') return; // FilmCraft readiness follows start(), not a loading DOM node.
  const failed = await boot('loading-failure');
  failed.poll();
  assert.match(failed.reports[0].message.error, /failed to start/);
  assert.equal(failed.handle.state.ready, false);
  const waiting = await boot('retained-loading');
  waiting.poll();
  assert.equal(waiting.handle.state.ready, appId === 'printcraft');
});
