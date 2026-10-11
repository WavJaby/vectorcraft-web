// Same-origin frame owns canvas geometry, input and the unmodified official application.
import {startCanvasEditor} from './app-loader.js';

const config = parent.VECTORCRAFT_DELIVERY;
document.documentElement.lang = parent.document.documentElement.lang;
const report = detail => parent.postMessage({type: 'vectorcraft-startup', ...detail}, location.origin);
document.addEventListener('editor-fatal', event => report({error: event.detail}));
try {
  const handle = await startCanvasEditor(config);
  if (!handle.state.error) {
    const timer = setInterval(() => {
      const loading = document.getElementById(`${config.appId}_loading`);
      if (loading?.textContent.includes('failed to start')) {
        report({error: loading.textContent});
        clearInterval(timer);
      } else if (handle.canvas.hasAttribute('tabindex') && handle.canvas.width > 0 && handle.canvas.height > 0 && !loading) {
        handle.state.ready = true;
        report({ready: true, canvasSizing: handle.state.canvasSizing});
        clearInterval(timer);
      }
    }, config.uiPollMs);
  }
} catch (error) { report({error: String(error?.stack || error)}); }
