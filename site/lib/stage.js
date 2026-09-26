// Shared page plumbing: colour scale, canvas backing-store sizing, GL capability.
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const hue = (score) => `hsl(${clamp(score, 0, 100) * 1.2},95%,55%)`;
export const lerp = (a, b, t) => a + (b - a) * t;
// Metric labels and config strings are data; escape before any innerHTML use.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 'stale': the panel has real data, but it is a held-over last-good value rather than a fresh
// read (a source that dropped out of the current poll) — distinct from 'pending' (no source
// wired up yet) and 'error' (the query itself failed).
const STATES = new Set(['ok', 'empty', 'pending', 'error', 'stale']);

// `message` is recorded on the panel (data-panel-message-text, invisible) for automation/tests,
// but only ever painted into the visible [data-panel-message] node for state 'ok' — every other
// state (pending/empty/error/stale) always has stand-in content on screen instead (sampleData.js,
// setSampleBadge below), so its message never needs to be, and must not be, visible.
export function setState(panel, state, message = '') {
  if (!STATES.has(state)) throw new Error(`unknown panel state: ${state}`);
  panel.dataset.state = state;
  const notice = panel.querySelector('[data-panel-message]');
  if (notice) notice.textContent = state === 'ok' ? message : '';
}

// App health score scale (site/lib/queries.js APP_HEALTH_SCORE): 0-9 is the normal range; 10 is
// reserved for 100% success over the trailing 30d. OK/DEGRADED/DOWN tiers derive from these two
// constants, never a second hardcoded copy of the cutoffs.
export const SCORE_OK_MIN = 8;
export const SCORE_DEGRADED_MIN = 5;
// hue() expects a 0-100 input; a score maps onto it by this fixed x10 scale, which also matches
// the /10 arc-fraction pattern every score ring/glyph already uses.
export const scorePct = (s) => (s ?? 0) * 10;

// Mark a panel as showing site/lib/sampleData.js content in place of a real source that
// returned genuinely nothing this poll (a query that SUCCEEDED with zero rows) — machine-readable
// only (data-source, invisible), never a visible badge: the wall must never look non-production,
// live-empty included. `data-source` stays absent (equivalent to "live") until a page renders its
// first stand-in panel.
export function setSampleBadge(panel, on) {
  panel.dataset.source = on ? 'stand-in' : 'live';
}

// Marks an element (a whole panel, or one sub-element inside an otherwise-real panel, e.g. mc1's
// WAN overlay inside the real topology graph) as showing stand-in visuals for a feed that has NO
// live source wired up AT ALL — as opposed to setSampleBadge's "a live query came back empty".
// Deliberately invisible on the rendered page (a `data-source` attribute only, no on-screen
// badge/"PENDING" text) so a stand-in panel reads as a normal, finished part of the wall; it never
// overrides a live signal — nothing that has a real feed ever gets marked this way, live or down.
export function setStandIn(el, on) {
  if (on) el.dataset.source = 'stand-in';
  else delete el.dataset.source;
}

// The page has no fixed design surface: the stage is 100vw x 100dvh (wall.css) and every grid
// cell is fr/minmax(0,1fr)-sized, so the grid itself can never overflow its container.
// A canvas inside a cell must size its backing store from the CELL's box, via a ResizeObserver
// on the cell — never from the canvas's own rendered size. That self-reference (read the
// canvas's rendered size, write it back as the backing-store resolution, which is itself part
// of what determines the rendered size) is what grew a panel without bound.
export function observeCanvas(cell, canvas, onResize) {
  const apply = () => {
    const dpr = adaptiveDpr();
    const w = Math.round(cell.clientWidth * dpr), h = Math.round(cell.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; onResize?.(w, h); }
  };
  const ro = new ResizeObserver(apply);
  ro.observe(cell);
  apply();
  onDispose(() => ro.disconnect());
  return ro;
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

// ---------------------------------------------------------------------------
// Disposal registry: a page registers cleanup (renderer/geometry/material/
// texture disposal, clearInterval, ResizeObserver#disconnect) here, and it all
// runs once on `pagehide` — the kiosk never navigates away without unloading,
// so this is the only teardown hook a page needs.
const disposers = [];
export function onDispose(cleanup) {
  disposers.push(cleanup);
  return cleanup;
}
window.addEventListener('pagehide', () => {
  while (disposers.length) {
    try { disposers.pop()(); } catch (e) { console.warn('dispose', e); }
  }
}, { once: true });

// Standard three.js teardown: walk the scene disposing every geometry/material
// (and any texture maps a material holds), then release the renderer's own GPU
// context. Traversal-based rather than a hand-built per-object registry — it
// reaches everything actually attached to the scene with no bookkeeping.
export function disposeThreeScene(renderer, scene) {
  scene?.traverse((obj) => {
    obj.geometry?.dispose?.();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'alphaMap', 'aoMap', 'emissiveMap', 'envMap', 'lightMap', 'normalMap']) m[k]?.dispose?.();
      m.dispose?.();
    }
  });
  renderer?.dispose();
  renderer?.forceContextLoss();
}

// WebGL context loss/restore: the browser can reclaim a context under GPU
// pressure at any time. `preventDefault()` on the loss event is what tells the
// browser this page will rebuild instead of staying dead; `rebuild` runs once
// the context is usable again.
export function onContextLoss(canvas, rebuild) {
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
  canvas.addEventListener('webglcontextrestored', rebuild, false);
}

// ---------------------------------------------------------------------------
// Render/idle lifecycle: the rotator (site/rotator/rotator.js) posts
// {wall:'idle'|'active'} to a same-origin slide as it goes off/on screen, and
// a page's own tab visibility does the same thing locally — either one pauses
// every loop() on this page rather than rendering behind a slide no one sees.
let idle = document.hidden;
const wakers = new Set();
function setIdle(v) {
  if (idle === v) return;
  idle = v;
  if (!idle) for (const wake of wakers) wake();
}
document.addEventListener('visibilitychange', () => setIdle(document.hidden));
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  if (e.data?.wall === 'idle') setIdle(true);
  else if (e.data?.wall === 'active') setIdle(false);
});

// Posts {wall:'ready'} to the parent frame once, for the rotator's probe (site/rotator/rotator.js
// buildLayers()) — a same-origin slide proves itself alive this way. loop() below calls it after
// its first painted frame; a page with no continuous render loop (e.g. mc5, which redraws only on
// data refresh/resize) calls it directly instead, right after its first synchronous paint.
let signaled = false;
export function signalReady() {
  if (signaled) return;
  signaled = true;
  try { window.parent?.postMessage({ wall: 'ready' }, location.origin); } catch { /* no parent to tell */ }
}

// ---------------------------------------------------------------------------
// Adaptive render quality: the shock-and-awe hero scenes (mc2/mc3/mc4) run their canvas
// uncapped (loop(0, ...) below) — fine on the operator's display machine, but under real
// contention (CI's software-GL renderer running several pages in parallel; also weaker real
// hardware) the same uncapped loop, full DPR and always-on bloom can starve the main thread.
// One rolling frame-time average, sampled every uncapped frame, steps a single quality tier
// down — DPR to 1, then bloom off, then a 30fps cap — when the average frame is heavier than
// ~40ms, and steps back up (in reverse) once there's sustained headroom. No UA/test sniffing:
// this reacts to the actual measured cost of the frame just rendered, on any machine.
const TIER_DPR = 1, TIER_BLOOM = 2, TIER_FPS = 3;
let qTier = 0;
let emaFrameMs = 16; // seeded at a healthy 60fps frame
let lastTierChangeAt = 0;
const STEP_DOWN_MS = 40, STEP_UP_MS = 20, TIER_COOLDOWN_MS = 2000;
function sampleFrameCost(dtMs) {
  emaFrameMs = emaFrameMs * 0.9 + dtMs * 0.1;
  const now = performance.now();
  if (now - lastTierChangeAt < TIER_COOLDOWN_MS) return;
  if (emaFrameMs > STEP_DOWN_MS && qTier < TIER_FPS) { qTier += 1; lastTierChangeAt = now; }
  else if (emaFrameMs < STEP_UP_MS && qTier > 0) { qTier -= 1; lastTierChangeAt = now; }
}
// Read by observeCanvas (canvas backing-store resolution) and by a page's own bloom setup.
export function adaptiveDpr(max = 2) { return qTier >= TIER_DPR ? Math.min(max, 1) : max; }
export function adaptiveBloomOn() { return qTier < TIER_BLOOM; }

// requestAnimationFrame capped at `fps` (never above 30) — or, with `fps <= 0`, uncapped: fn runs
// every rAF tick at the display's native refresh rate (the shock-and-awe hero scenes; the
// operator confirmed the display machine has headroom to spare, and adaptive quality above
// covers it when that assumption doesn't hold). An uncapped caller falls back to a 30fps cap of
// its own once the quality tier says the machine can't keep up. Paused while idle (see above)
// and disposed on pagehide either way.
export function loop(fps, fn) {
  const requestedUncapped = fps <= 0;
  let last = 0, handle = null;
  const tick = (now) => {
    handle = null;
    if (idle) return; // wake() restarts the rAF chain once active again
    const uncapped = requestedUncapped && qTier < TIER_FPS;
    const min = uncapped ? 0 : 1000 / Math.min(fps > 0 ? fps : 30, 30);
    const dt = now - last;
    if (uncapped || dt >= min - 1) {
      if (requestedUncapped && last) sampleFrameCost(dt);
      fn(now, Math.min(dt / 1000, 0.1));
      last = now;
      requestAnimationFrame(signalReady); // one frame after this one is committed
    }
    handle = requestAnimationFrame(tick);
  };
  const wake = () => { if (handle == null) handle = requestAnimationFrame(tick); };
  wakers.add(wake);
  wake();
  onDispose(() => { if (handle != null) cancelAnimationFrame(handle); wakers.delete(wake); });
}

export async function loadConfig() {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}
