const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../hardware-check.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.replaceAll('export async function', 'async function'), context);
function environment(gpu, gl) {
  return {navigator: {gpu, hardwareConcurrency: 8}, document: {createElement: () => ({getContext: () => gl})}, setTimeout, clearTimeout};
}
test('adapter and WebGL2 probes report support and release temporary context', async () => {
  let released = false;
  const env = environment({requestAdapter: async () => ({info: {description: 'Test GPU'}})}, {RENDERER: 'renderer', getParameter: () => 'GL GPU', getExtension: () => ({loseContext: () => {released = true;}})});
  const result = await context.inspectHardware(env, 1000); // Fixture deadline; resolved adapter should never reach it.
  assert.equal(result.webgpu, 'available');
  assert.equal(result.webgl2, 'available');
  assert.equal(result.gpu, 'Test GPU');
  assert.equal(result.memory, undefined);
  assert(released);
});
test('absent APIs and null adapter are unavailable', async () => {
  for (const gpu of [undefined, {requestAdapter: async () => null}]) {
    const result = await context.inspectHardware(environment(gpu, null), 1000);
    assert.equal(result.webgpu, 'unavailable');
    assert.equal(result.webgl2, 'unavailable');
    assert.equal(result.isolated, false);
    assert.equal(result.webcodecs, false);
  }
});
test('denied APIs are check failures; stalled adapter is bounded', async () => {
  const env = environment({requestAdapter: async () => {throw new Error('denied');}}, null);
  env.document.createElement = () => {throw new Error('denied');};
  const failed = await context.inspectHardware(env, 1000);
  assert.equal(failed.webgpu, 'failed');
  assert.equal(failed.webgl2, 'failed');
  env.navigator.gpu.requestAdapter = () => new Promise(() => {});
  // Immediate injected clock exercises the timeout branch without a wall-clock assertion.
  env.setTimeout = callback => {callback(); return undefined;};
  assert.equal((await context.inspectHardware(env, 0)).webgpu, 'timeout');
});
