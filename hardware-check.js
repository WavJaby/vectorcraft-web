// Capability probes only; never select the app renderer or delay its startup.
export async function inspectHardware(env, timeoutMs) {
  let webgpu = 'unavailable';
  let gpu = '';
  let timer;
  if (env.navigator.gpu) {
    try {
      const adapter = await Promise.race([
        env.navigator.gpu.requestAdapter(),
        new Promise((_, reject) => { timer = env.setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
      ]);
      webgpu = adapter ? 'available' : 'unavailable';
      gpu = adapter?.info?.description || adapter?.info?.device || adapter?.info?.vendor || '';
    } catch (error) { webgpu = error.message === 'timeout' ? 'timeout' : 'failed'; }
    finally { env.clearTimeout(timer); }
  }
  let webgl2 = 'unavailable';
  try {
    const canvas = env.document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl) {
      webgl2 = 'available';
      if (!gpu) gpu = gl.getParameter(gl.RENDERER) || '';
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { webgl2 = 'failed'; }
  return {webgpu, webgl2, gpu, cores: env.navigator.hardwareConcurrency, memory: env.navigator.deviceMemory, isolated: env.crossOriginIsolated === true, webcodecs: typeof env.VideoDecoder === 'function'};
}

export async function showHardwareResults(container, chinese, timeoutMs) {
  const text = (en, zh) => chinese ? zh : en;
  const section = document.createElement('section');
  section.id = 'hardware-results';
  section.className = 'note';
  section.setAttribute('aria-live', 'polite');
  section.style.whiteSpace = 'pre-line';
  section.textContent = text('Checking browser hardware capabilities…', '正在檢查瀏覽器硬體能力…');
  container.querySelector('#loading-detail').after(section);
  // Bound adapter discovery to the existing worker startup deadline; probes run beside the download.
  const result = await inspectHardware(globalThis, timeoutMs);
  const labels = {available: text('available', '可用'), unavailable: text('unavailable', '不可用'), timeout: text('timed out', '逾時'), failed: text('check failed', '檢查失敗')};
  const unknown = text('not reported', '未提供');
  section.textContent = [
    text('Browser capability check (not a benchmark)', '瀏覽器能力檢查（非效能跑分）'),
    `WebGPU: ${labels[result.webgpu]} · WebGL2: ${labels[result.webgl2]}`,
    `GPU: ${result.gpu || unknown}`,
    `${text('Logical CPUs', '邏輯處理器')}: ${result.cores || unknown} · ${text('Approx. memory', '概略記憶體')}: ${result.memory ? result.memory + ' GiB' : unknown}`,
    `WebCodecs: ${result.webcodecs ? labels.available : labels.unavailable} · crossOriginIsolated: ${result.isolated}`,
    text('Support does not confirm hardware acceleration or the renderer selected by the app. Browser-reported values may be limited for privacy.', '支援不代表已使用硬體加速或程式實際選用的後端；瀏覽器可能因隱私限制回報資訊。'),
  ].join('\n');
  section.dataset.complete = 'true';
  return result;
}
