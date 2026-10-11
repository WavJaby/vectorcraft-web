const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app-loader.js'), 'utf8');

test('canvas sizes follow DPR, preserve upstream type checks, and leave other targets untouched', () => {
  let deliver;
  class ResizeObserver { constructor(callback) { deliver = callback; } }
  class ResizeObserverSize { constructor(width, height) { this.inlineSize = width; this.blockSize = height; } }
  class ResizeObserverEntry {}
  const window = {ResizeObserver, devicePixelRatio: 2};
  const context = vm.createContext({window});
  vm.runInContext(source.slice(0, source.indexOf('export async function')).replace('export function', 'function'), context);
  const canvas = {};
  const measurements = context.installCanvasPixelSizing(canvas);
  let result;
  const observer = new window.ResizeObserver((entries, instance) => { result = {entries, instance}; });
  // Probe: CSS width 836.25 * native DPR 1.6 = 1338; emulated DPR = 2.
  const entry = Object.assign(new ResizeObserverEntry(), {target: canvas, contentRect: {width: 836.25, height: 842.5}, devicePixelContentBoxSize: [new ResizeObserverSize(1338, 1348)]});
  const other = {target: {}};
  deliver([entry, other], observer);
  assert(result.entries[0] instanceof ResizeObserverEntry);
  const size = result.entries[0].devicePixelContentBoxSize[0];
  assert(size instanceof ResizeObserverSize);
  assert.equal(size.inlineSize, Math.round(entry.contentRect.width * window.devicePixelRatio));
  assert.equal(size.blockSize, Math.round(entry.contentRect.height * window.devicePixelRatio));
  assert.equal(result.entries[1], other);
  assert.equal(result.instance, observer);
  assert.equal(measurements.corrected, 1);
  window.devicePixelRatio = 1.6;
  entry.devicePixelContentBoxSize = [new ResizeObserverSize(Math.round(entry.contentRect.width * window.devicePixelRatio), Math.round(entry.contentRect.height * window.devicePixelRatio))];
  deliver([entry], observer);
  assert.equal(result.entries[0].devicePixelContentBoxSize[0].inlineSize, entry.devicePixelContentBoxSize[0].inlineSize);
  assert.equal(measurements.corrected, 1);
  delete entry.devicePixelContentBoxSize;
  deliver([entry], observer);
  assert.equal(result.entries[0], entry);
  assert.equal(measurements.deliveries, 3);
  assert.equal(window.devicePixelRatio, 1.6);
});
