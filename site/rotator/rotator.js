// Rotator: shows one slide at a time on `/`. Slides come from /config.json's `slides` key
// ([{name, url, seconds?}]); with no key, DEFAULT_SLIDES is used. One persistent <iframe> per
// slide is created once at startup and never re-navigated afterwards — switching slides toggles
// visibility, it never swaps `.src`, so a slide's own render context (WebGL, timers) is created
// once and lives for the wall's whole session; site/lib/stage.js is what pauses/resumes and
// eventually disposes it, not this file.
const DEFAULT_SLIDES = [
  { name: 'MC1', url: '/mc1/' },
  { name: 'MC2', url: '/mc2/' },
  { name: 'MC3', url: '/mc3/' },
  { name: 'MC4', url: '/mc4/' },
  { name: 'MC5', url: '/mc5/' },
];
const MIN_HOLD = 30;
const MAX_HOLD = 60;
const DEFAULT_HOLD = 45;
const DEFAULT_SECONDS = 10;
const IDLE_HIDE_MS = 3000;
const PROBE_TIMEOUT_MS = 5000;
const SKIP_NOTE_MS = 4000;
const FADE_MS = 800; // matches .layer{transition:opacity .8s ease} below
// ponytail: hard ceiling under Chromium's 16-context-per-page limit — the configured slide count
// (6: MC1-5 + Glance) is nowhere near it. Raise only if that changes.
const MAX_LAYERS = 8;
const CIRC = 2 * Math.PI * 6;

let slides = DEFAULT_SLIDES;
let holdSeconds = DEFAULT_HOLD;
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
const sameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};

function postWall(layer, state) {
  if (!layer.sameOrigin) return; // cross-origin content (Glance) has nothing listening for this
  try { layer.el.contentWindow?.postMessage({ wall: state }, location.origin); } catch { /* torn down mid-message */ }
}

// One persistent iframe per slide, created once and never re-navigated. A same-origin slide
// proves itself alive by posting {wall:'ready'} once its own site/lib/stage.js render loop has
// painted a first frame; a probe window with no 'ready' means it's broken (Track G3) — the same
// conclusion the cross-origin probe below draws from a failed or stalled load.
function buildLayers() {
  layersEl.innerHTML = '';
  layers = slides.slice(0, MAX_LAYERS).map((slide) => {
    const el = document.createElement('iframe');
    el.className = 'layer';
    el.title = slide.name || 'slide';
    layersEl.appendChild(el);
    const layer = { el, name: slide.name, sameOrigin: sameOrigin(slide.url), hideTimer: null };
    let settled = false, resolveReady;
    layer.readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    layer.finish = (ok) => { if (settled) return; settled = true; resolveReady(ok); };
    if (!layer.sameOrigin) {
      // ponytail: cross-origin reachability is a load-vs-timeout race (no HTTP status and no
      // 'ready' handshake visible across origins) — a slow-but-healthy cross-origin slide can
      // misclassify as broken. The live browser check (Track V2) is what actually verifies these.
      el.addEventListener('load', () => layer.finish(true));
      el.addEventListener('error', () => layer.finish(false));
    }
    setTimeout(() => layer.finish(false), PROBE_TIMEOUT_MS);
    el.src = slide.url;
    return layer;
  });
}

window.addEventListener('message', (e) => {
  if (e.data?.wall !== 'ready') return;
  layers.find((l) => l.sameOrigin && l.el.contentWindow === e.source)?.finish(true);
});

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

function showSkipped(name) {
  clearTimeout(skipTimer);
  let note = document.getElementById('skip');
  if (!note) {
    note = document.createElement('span');
    note.id = 'skip';
    dotsEl.appendChild(note);
  }
  note.textContent = `skipped: ${name || 'slide'}`;
  showDots();
  skipTimer = setTimeout(() => note.remove(), SKIP_NOTE_MS);
}

function renderDots() {
  const note = document.getElementById('skip');
  dotsEl.innerHTML = '';
  slides.slice(0, layers.length).forEach((slide, i) => {
    const dot = document.createElement('button');
    dot.className = 'dot' + (i === current ? ' current' : '');
    dot.setAttribute('aria-label', slide.name || `slide ${i + 1}`);
    dot.innerHTML = `<svg viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="6"/><circle class="ring" cx="8" cy="8" r="6" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/></svg>`;
    dot.addEventListener('click', (e) => { e.stopPropagation(); pin(); goTo(i); });
    dotsEl.appendChild(dot);
  });
  if (note) dotsEl.appendChild(note);
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
  rotateTimer = setTimeout(() => step(1), holdMs());
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

function scheduleNightlyReload() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => location.reload(), next - now);
}

async function init() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const cfg = await res.json();
    if (Array.isArray(cfg.slides) && cfg.slides.length) slides = cfg.slides;
    if (typeof cfg.holdSeconds === 'number') holdSeconds = clamp(cfg.holdSeconds, MIN_HOLD, MAX_HOLD);
  } catch { /* keep defaults */ }
  buildLayers();
  const idx = await resolveSlide(0);
  current = idx === null ? 0 : idx;
  activateLayer(current);
  renderDots();
  scheduleRotate();
  scheduleNightlyReload();
}

init();
