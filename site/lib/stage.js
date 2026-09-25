// Shared page plumbing: colour scale, canvas backing-store sizing, GL capability.
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const hue = (score) => `hsl(${clamp(score, 0, 100) * 1.2},95%,55%)`;
export const lerp = (a, b, t) => a + (b - a) * t;
// Metric labels and config strings are data; escape before any innerHTML use.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATES = new Set(['ok', 'empty', 'pending', 'error']);

export function setState(panel, state, message = '') {
  if (!STATES.has(state)) throw new Error(`unknown panel state: ${state}`);
  panel.dataset.state = state;
  const notice = panel.querySelector('[data-panel-message]');
  if (notice) notice.textContent = message;
}

// The page has no fixed design surface: the stage is 100vw x 100dvh (wall.css) and every grid
// cell is fr/minmax(0,1fr)-sized, so the grid itself can never overflow its container.
// A canvas inside a cell must size its backing store from the CELL's box, via a ResizeObserver
// on the cell — never from the canvas's own rendered size. That self-reference (read the
// canvas's rendered size, write it back as the backing-store resolution, which is itself part
// of what determines the rendered size) is what grew a panel without bound.
export function observeCanvas(cell, canvas, onResize) {
  const apply = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(cell.clientWidth * dpr), h = Math.round(cell.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; onResize?.(w, h); }
  };
  new ResizeObserver(apply).observe(cell);
  apply();
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
