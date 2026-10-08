// Community bootstrap; official JavaScript and Wasm remain separate, byte-verified inputs.
export function gpuFallbackUrl(error, href) {
  const url = new URL(href);
  if (url.searchParams.has('webgl') || url.searchParams.has('cpu') || !/wgpu|webgpu|requestDevice|requestAdapter|GPUDevice|surface/i.test(error)) return null;
  url.searchParams.set('webgl', '');
  return url.href;
}

export async function startEditor(config) {
  const surface = document.createElement('div');
  surface.id = 'editor-surface';
  const canvas = document.createElement('canvas');
  canvas.id = config.canvasId;
  const upstreamLoading = document.createElement('div');
  upstreamLoading.id = `${config.appId}_loading`;
  upstreamLoading.hidden = true;
  surface.append(canvas, upstreamLoading);
  document.getElementById('editor-host').replaceChildren(surface);
  const state = { ready: false, error: null };
  const started = performance.now();
  const fatal = error => {
    state.error = String(error?.stack || error);
    document.dispatchEvent(new CustomEvent('editor-fatal', {detail: state.error}));
  };
  const trapped = error => error instanceof WebAssembly.RuntimeError || /panicked at|memory access out of bounds/.test(String(error));
  addEventListener('error', event => { if (state.ready && trapped(event.error)) fatal(event.error); });
  addEventListener('unhandledrejection', event => { if (state.ready && trapped(event.reason)) fatal(event.reason); });
  try {
    const bindings = await import(new URL(config.jsPath + (config.bootstrap === 'filmcraft' ? `?v=${config.revision}` : ''), location.href));
    const wasmUrl = new URL(config.wasmPath, location.href);
    if (config.bootstrap === 'filmcraft') wasmUrl.searchParams.set('v', config.revision);
    const wasm = await bindings.default({module_or_path: wasmUrl});
    window.wasmBindings = bindings;
    if (config.bootstrap === 'filmcraft') {
      window.filmcraftLoad = {wasmMs: performance.now() - started};
      await bindings.start(config.canvasId);
      window.filmcraftLoad.readyMs = performance.now() - started;
      upstreamLoading.remove();
    } else {
      dispatchEvent(new CustomEvent('TrunkApplicationStarted', {detail: {wasm}}));
    }
  } catch (error) { fatal(error); }
  return {state, canvas, upstreamLoading};
}
