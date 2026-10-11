// Community bootstrap; official JavaScript and Wasm remain separate, byte-verified inputs.
export function gpuFallbackUrl(error, href) {
  const url = new URL(href);
  if (url.searchParams.has('webgl') || url.searchParams.has('cpu') || !/wgpu|webgpu|requestDevice|requestAdapter|GPUDevice|surface/i.test(error)) return null;
  url.searchParams.set('webgl', '');
  return url.href;
}

function installCanvasPixelSizing(canvas) {
  const NativeResizeObserver = window.ResizeObserver;
  const measurements = { deliveries: 0, corrected: 0 };
  // eframe sizes from devicePixelContentBoxSize but maps input using window DPR; keep both on the same pixel basis.
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) {
      super((entries, observer) => callback(entries.map(entry => {
        if (entry.target !== canvas) return entry;
        measurements.deliveries++;
        const observed = entry.devicePixelContentBoxSize?.[0];
        if (!observed) return entry;
        const size = {
          inlineSize: Math.round(entry.contentRect.width * window.devicePixelRatio),
          blockSize: Math.round(entry.contentRect.height * window.devicePixelRatio)
        };
        if (observed.inlineSize !== size.inlineSize || observed.blockSize !== size.blockSize) measurements.corrected++;
        // Wasm checks instanceof ResizeObserverSize; plain objects fail the upstream cast.
        const pixelSize = new Proxy(observed, {
          get(target, property) {
            if (property === 'inlineSize' || property === 'blockSize') return size[property];
            return Reflect.get(target, property, target);
          }
        });
        return new Proxy(entry, {
          get(target, property) {
            if (property === 'devicePixelContentBoxSize') return [pixelSize];
            return Reflect.get(target, property, target);
          }
        });
      }), observer));
    }
  };
  return measurements;
}

export async function startCanvasEditor(config) {
  const surface = document.createElement('div');
  surface.id = 'editor-surface';
  const canvas = document.createElement('canvas');
  canvas.id = config.canvasId;
  const upstreamLoading = document.createElement('div');
  upstreamLoading.id = `${config.appId}_loading`;
  upstreamLoading.hidden = true;
  surface.append(canvas, upstreamLoading);
  document.getElementById('editor-host').replaceChildren(surface);
  const state = { ready: false, error: null, canvasSizing: installCanvasPixelSizing(canvas) };
  const fatal = error => {
    state.error = String(error?.stack || error);
    document.dispatchEvent(new CustomEvent('editor-fatal', {detail: state.error}));
  };
  const trapped = error => error instanceof WebAssembly.RuntimeError || /panicked at|memory access out of bounds/.test(String(error));
  addEventListener('error', event => { if (state.ready && trapped(event.error)) fatal(event.error); });
  addEventListener('unhandledrejection', event => { if (state.ready && trapped(event.reason)) fatal(event.reason); });
  try {
    const bindings = await import(new URL(config.jsPath, location.href));
    const wasmUrl = new URL(config.wasmPath, location.href);
    const wasm = await bindings.default({module_or_path: wasmUrl});
    window.wasmBindings = bindings;
    dispatchEvent(new CustomEvent('TrunkApplicationStarted', {detail: {wasm}}));
  } catch (error) { fatal(error); }
  return {state, canvas, upstreamLoading};
}

export async function startEditor() {
  const frame = document.createElement('iframe');
  frame.id = 'editor-surface';
  frame.title = 'VectorCraft editor';
  frame.allow = 'clipboard-read; clipboard-write; fullscreen';
  const state = {ready: false, error: null};
  const url = new URL('./editor.html', location.href);
  url.search = location.search;
  url.hash = location.hash;
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'vectorcraft-startup') return;
    if (event.data.error) {
      state.error = event.data.error;
      document.dispatchEvent(new CustomEvent('editor-fatal', {detail: state.error}));
    } else if (event.data.ready) {
      state.ready = true;
      state.canvasSizing = event.data.canvasSizing;
    }
  });
  frame.src = url.href;
  document.getElementById('editor-host').replaceChildren(frame);
  return {state, frame};
}
