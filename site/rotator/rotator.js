import { scheduleReload } from './reload.js';

// Configured or default slides keep persistent iframes. stage.js pauses hidden pages.
const DEFAULT_SLIDES = [
  { name: 'MC1', url: '/mc1/' },
  { name: 'MC2', url: '/mc2/' },
  { name: 'MC3', url: '/mc3/' },
  { name: 'MC4', url: '/mc4/' },
  { name: 'MC5', url: '/mc5/' },
  { name: 'LEXICON', url: '/mc6/' },
  { name: 'AI Benchmark Cockpit', url: '/mc7/' },
  { name: 'SWITCHBOARD', url: '/mc8/' },
  { name: 'Agent Constellation', url: '/mc9/' },
];
const MIN_HOLD = 30;
const MAX_HOLD = 60;
const DEFAULT_HOLD = 45;
const DEFAULT_SECONDS = 10;
const MIN_RELOAD_MINUTES = 5;
const MAX_RELOAD_MINUTES = 1440;
const DEFAULT_RELOAD_MINUTES = 60;
const IDLE_HIDE_MS = 3000;
const PROBE_TIMEOUT_MS = 5000;
const SKIP_NOTE_MS = 4000;
// A layer whose probe timed out is skipped forever without this: re-probe it periodically so a
// slide that was down at boot (or hung mid-session) can rejoin rotation once it recovers.
const REPROBE_MS = 5 * 60 * 1000;
const FADE_MS = 800; // matches .layer{transition:opacity .8s ease} below
// Stay below Chromium's 16-context WebGL limit; slides past this ceiling are omitted.
const MAX_LAYERS = 10;
const CIRC = 2 * Math.PI * 6;

let slides = DEFAULT_SLIDES;
let holdSeconds = DEFAULT_HOLD;
let reloadMinutes = DEFAULT_RELOAD_MINUTES;
let layers = []; // one persistent { el, name, sameOrigin, readyPromise, finish, hideTimer } per slide
let current = 0;
let paused = false;
let holding = false;
let busy = false;
let rotateTimer = null;
let holdTimer = null;
let hideDotsTimer = null;
let skipTimer = null;

const layersEl = document.getElementById('layers');
const dotsEl = document.getElementById('dots');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const wrap = (i) => ((i % layers.length) + layers.length) % layers.length;
// A test-only override (never read by anything except this line): shortens every hold to
// `fast` ms so a CI run can exercise many rotation cycles without waiting out a real 30-60s hold.
const FAST_MS = Number(new URLSearchParams(location.search).get('fast')) || 0;
const holdMs = () => FAST_MS || (slides[current]?.seconds ?? DEFAULT_SECONDS) * 1000;
// A test-only override (never read by real config), mirroring `?fast=`: shortens the re-probe
// interval so a test can exercise it without waiting out the real 5 minutes.
const REPROBE_OVERRIDE_MS = Number(new URLSearchParams(location.search).get('reprobe')) || 0;
const sameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};

function postWall(layer, state) {
  if (!layer.sameOrigin) return; // cross-origin content (Glance) has nothing listening for this
  try { layer.el.contentWindow?.postMessage({ wall: state }, location.origin); } catch { /* torn down mid-message */ }
}

// Creation and recovery both get a new readiness promise and deadline.
function armLayer(layer) {
  let settled = false, resolveReady;
  layer.ok = null;
  layer.readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  layer.finish = (ok) => {
    if (settled) {
      // A late 'ready' (heavy WebGL slides can post it after PROBE_TIMEOUT_MS lapsed and this
      // layer already settled false) rejoins rotation immediately instead of waiting for the
      // next reprobeBroken() cycle: swap in an already-resolved promise so any in-flight or
      // future resolveSlide() call sees it as ready right away.
      if (ok && layer.ok === false) { layer.ok = true; layer.readyPromise = Promise.resolve(true); }
      return;
    }
    settled = true; layer.ok = ok; resolveReady(ok);
  };
  clearTimeout(layer.timeoutId);
  layer.timeoutId = setTimeout(() => layer.finish(false), PROBE_TIMEOUT_MS);
}

// Forward the renderer override only to same-origin wall pages.
const FORWARDED_GL = new URLSearchParams(location.search).get('gl');
function slideUrl(url) {
  if (!FORWARDED_GL || !sameOrigin(url)) return url;
  const u = new URL(url, location.href);
  if (!/^\/mc\d+\//.test(u.pathname)) return url;
  u.searchParams.set('gl', FORWARDED_GL);
  return u.pathname + u.search + u.hash;
}

function buildLayers() {
  layersEl.innerHTML = '';
  layers = slides.slice(0, MAX_LAYERS).map((slide) => {
    const el = document.createElement('iframe');
    el.className = 'layer';
    el.title = slide.name || 'slide';
    layersEl.appendChild(el);
    const url = slideUrl(slide.url);
    const layer = { el, name: slide.name, url, sameOrigin: sameOrigin(url), hideTimer: null };
    if (!layer.sameOrigin) {
      // ponytail: cross-origin reachability is a load-vs-timeout race (no HTTP status and no
      // 'ready' handshake visible across origins) — a slow-but-healthy cross-origin slide can
      // misclassify as broken. The live browser check (Track V2) is what actually verifies these.
      // Attached once: armLayer() only replaces layer.finish, which these always read live.
      el.addEventListener('load', () => layer.finish(true));
      el.addEventListener('error', () => layer.finish(false));
    }
    armLayer(layer);
    el.src = url;
    return layer;
  });
}

window.addEventListener('message', (e) => {
  if (e.data?.wall !== 'ready') return;
  layers.find((l) => l.sameOrigin && l.el.contentWindow === e.source)?.finish(true);
});

// Re-probe only failed layers; healthy or still-loading pages keep their contexts.
function reprobeBroken() {
  for (const layer of layers) {
    if (layer.ok !== false) continue;
    armLayer(layer);
    reloadLayer(layer);
  }
}
function reloadLayer(layer) {
  const el = layer.el;
  // Force a fresh navigation even if the URL is unchanged (a same-origin slide) — a cache-busting
  // query param, not a reassignment of the identical src, which most browsers no-op.
  const url = new URL(layer.url, location.href);
  url.searchParams.set('_reprobe', String(Date.now()));
  el.src = url.href;
}
setInterval(reprobeBroken, REPROBE_OVERRIDE_MS || REPROBE_MS);

// Recursive, not a for-loop: each candidate's readiness must be awaited in order and the search
// stops at the first ready one, so the attempts are inherently sequential.
async function resolveSlide(startIndex, tries = 0) {
  if (tries >= layers.length) return null;
  const idx = wrap(startIndex + tries);
  const ok = await layers[idx].readyPromise;
  if (ok) return idx;
  showSkipped(layers[idx].name);
  return resolveSlide(startIndex, tries + 1);
}

// Machine-readable only — the operator's aesthetics rule bans any non-production text on the
// wall itself, so a skip is signalled solely via `data-skipped` on the dots container, never a
// visible note.
function showSkipped(name) {
  clearTimeout(skipTimer);
  dotsEl.dataset.skipped = name || 'slide';
  showDots();
  skipTimer = setTimeout(() => { delete dotsEl.dataset.skipped; }, SKIP_NOTE_MS);
}

function renderDots() {
  dotsEl.innerHTML = '';
  slides.slice(0, layers.length).forEach((slide, i) => {
    const dot = document.createElement('button');
    dot.className = 'dot' + (i === current ? ' current' : '');
    dot.setAttribute('aria-label', slide.name || `slide ${i + 1}`);
    dot.innerHTML = `<svg viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="6"/><circle class="ring" cx="8" cy="8" r="6" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/></svg>`;
    dot.addEventListener('click', (e) => { e.stopPropagation(); pin(); goTo(i); });
    dotsEl.appendChild(dot);
  });
  if (holding) startRing();
}

function startRing() {
  const ring = dotsEl.querySelector('.dot.current .ring');
  if (!ring) return;
  ring.style.transition = 'none';
  ring.style.strokeDashoffset = String(CIRC);
  void ring.getBoundingClientRect();
  ring.style.transition = `stroke-dashoffset ${holdSeconds}s linear`;
  ring.style.strokeDashoffset = '0';
}

function hideRing() {
  const ring = dotsEl.querySelector('.dot.current .ring');
  if (ring) { ring.style.transition = 'none'; ring.style.strokeDashoffset = String(CIRC); }
}

// Shows layers[index], hides every other layer, and tells same-origin slides whether they're
// on-screen — site/lib/stage.js pauses a slide's render loop on {wall:'idle'} and resumes it on
// {wall:'active'} (R1), so an off-screen slide burns no GPU/CPU between its turns. Visibility
// (never display:none) keeps every layer's box in the layout, so it can never reflow the page.
function activateLayer(index) {
  layers.forEach((layer, i) => {
    if (i === index) {
      clearTimeout(layer.hideTimer);
      layer.el.style.visibility = 'visible';
      layer.el.classList.add('active');
      postWall(layer, 'active');
    } else {
      if (layer.el.classList.contains('active')) {
        layer.el.classList.remove('active');
        clearTimeout(layer.hideTimer);
        layer.hideTimer = setTimeout(() => { layer.el.style.visibility = 'hidden'; }, FADE_MS);
      }
      postWall(layer, 'idle');
    }
  });
}

async function commit(index) {
  current = index;
  activateLayer(index);
  renderDots();
  scheduleRotate();
}

// Navigation only — never pins. The automatic rotate timer calls this via step() too, and it
// must NOT re-arm the hold on its own tick (that would deadlock: pin() blocks the very
// scheduleRotate() call this same navigation is about to make). User-driven entry points
// (below) call pin() themselves before navigating.
async function goTo(requestedIndex) {
  if (busy) return;
  const target = wrap(requestedIndex);
  if (target === current) return;
  busy = true;
  try {
    const idx = await resolveSlide(target);
    if (idx !== null) await commit(idx);
  } finally {
    busy = false;
  }
}

function step(offset) { goTo(current + offset); }

function scheduleRotate() {
  clearTimeout(rotateTimer);
  if (paused || holding) return;
  // The pause/holding invariant is re-checked here, at fire time, not just when the timer was
  // armed: this is the actual guarantee ("never rotate while paused"), not the timer bookkeeping
  // above, which only prevents a *known* stale timer from firing — it can't prevent every path
  // that could otherwise leave an armed timer outliving a pause.
  rotateTimer = setTimeout(() => { if (!paused && !holding) step(1); }, holdMs());
}

function pin() {
  if (paused) return;
  holding = true;
  clearTimeout(rotateTimer);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(unhold, holdSeconds * 1000);
  showDots();
  startRing();
}

function unhold() {
  holding = false;
  hideRing();
  scheduleRotate();
}

function togglePause() {
  paused = !paused;
  clearTimeout(rotateTimer);
  clearTimeout(holdTimer);
  holding = false;
  hideRing();
  if (!paused) scheduleRotate();
}

function showDots() {
  dotsEl.classList.add('visible');
  clearTimeout(hideDotsTimer);
  hideDotsTimer = setTimeout(() => dotsEl.classList.remove('visible'), IDLE_HIDE_MS);
}

document.addEventListener('mousemove', () => { showDots(); pin(); });
document.addEventListener('click', (e) => {
  if (e.target.closest('.dot')) return;
  showDots();
  pin();
  step(1);
});
document.addEventListener('wheel', (e) => { showDots(); pin(); step(e.deltaY > 0 ? 1 : -1); }, { passive: true });
document.addEventListener('keydown', (e) => {
  showDots();
  if (e.key === 'ArrowRight') { pin(); step(1); }
  else if (e.key === 'ArrowLeft') { pin(); step(-1); }
  else if (e.key === 'p' || e.key === 'P') togglePause();
  else pin();
});

async function init() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const cfg = await res.json();
    if (Array.isArray(cfg.slides) && cfg.slides.length) slides = cfg.slides;
    if (typeof cfg.holdSeconds === 'number') holdSeconds = clamp(cfg.holdSeconds, MIN_HOLD, MAX_HOLD);
    if (typeof cfg.reloadMinutes === 'number') {
      reloadMinutes = clamp(cfg.reloadMinutes, MIN_RELOAD_MINUTES, MAX_RELOAD_MINUTES);
    }
  } catch { /* keep defaults */ }
  buildLayers();
  const idx = await resolveSlide(0);
  current = idx === null ? 0 : idx;
  activateLayer(current);
  renderDots();
  scheduleRotate();
  scheduleReload(reloadMinutes);
}

init();
