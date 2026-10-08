const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app-loader.js'), 'utf8');
const context = vm.createContext({URL});
vm.runInContext(source.slice(0, source.indexOf('export async function')).replace('export function', 'function'), context);
test('GPU startup failure chooses WebGL2 once and preserves project flags', () => {
  const next = context.gpuFallbackUrl('wgpu requestDevice failed', 'https://example.test/app/?empty&fresh');
  const url = new URL(next);
  assert(url.searchParams.has('webgl'));
  assert(url.searchParams.has('empty'));
  assert(url.searchParams.has('fresh'));
  assert.equal(context.gpuFallbackUrl('GPUDevice failed', next), null);
});
test('explicit CPU override and non-GPU failures do not reload', () => {
  assert.equal(context.gpuFallbackUrl('wgpu failed', 'https://example.test/?cpu'), null);
  assert.equal(context.gpuFallbackUrl('invalid application data', 'https://example.test/'), null);
});
test('host creates a canvas in the same document and never creates an iframe', () => {
  const host = fs.readFileSync(path.join(__dirname, '../site.js'), 'utf8');
  assert(!/createElement\(['"]iframe['"]\)|contentWindow|contentDocument/.test(host));
  assert(source.includes("document.createElement('canvas')"));
});
