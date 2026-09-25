// Shared page plumbing: 1920x1080 stage scaling, colour scale, GL capability.
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const hue = (score) => `hsl(${clamp(score, 0, 100) * 1.2},95%,55%)`;
export const lerp = (a, b, t) => a + (b - a) * t;
// Metric labels and config strings are data; escape before any innerHTML use.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function fitStage(el) {
  const fit = () => {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    el.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px,${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
  };
  addEventListener('resize', fit);
  fit();
}

// True when WebGL is backed by real hardware. A software rasteriser
// (SwiftShader, llvmpipe) would burn node CPU, so pages fall back to 2D.
export function hardwareGL() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return !/swiftshader|llvmpipe|software|basic render/i.test(String(r));
  } catch {
    return false;
  }
}

// requestAnimationFrame capped at `fps`.
export function loop(fps, fn) {
  const min = 1000 / fps;
  let last = 0;
  const tick = (now) => {
    if (now - last >= min - 1) { fn(now, Math.min((now - last) / 1000, 0.1)); last = now; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function loadConfig() {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}
