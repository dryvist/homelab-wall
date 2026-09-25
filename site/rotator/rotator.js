// Rotator: crossfades between slides on `/`. Slides come from /config.json's `slides` key
// ([{name, url, seconds?}]); with no key, DEFAULT_SLIDES is used. Only two <iframe> layers ever
// exist (current + preloaded next) — a slide that fails to load is skipped, never shown blank.
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
const CIRC = 2 * Math.PI * 6;

let slides = DEFAULT_SLIDES;
let holdSeconds = DEFAULT_HOLD;
let current = 0;
let paused = false;
let holding = false;
let busy = false;
let rotateTimer = null;
let holdTimer = null;
let hideDotsTimer = null;
let skipTimer = null;

const layerA = document.getElementById('layerA');
const layerB = document.getElementById('layerB');
let currentLayer = layerA;
let nextLayer = layerB;
const dotsEl = document.getElementById('dots');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const wrap = (i) => ((i % slides.length) + slides.length) % slides.length;
const slideSeconds = () => slides[current]?.seconds ?? DEFAULT_SECONDS;
const sameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};

// ponytail: cross-origin reachability is a load-vs-timeout race (no HTTP status visible across
// origins) — a slow-but-healthy cross-origin slide can misclassify as broken. Upgrade path: a
// same-origin health-check proxy, if that proves noisy in practice.
function urlReachable(layer, url) {
  if (sameOrigin(url)) {
    return fetch(new URL(url, location.href).href, { cache: 'no-store' })
      .then((res) => { if (res.ok) layer.src = url; return res.ok; })
      .catch(() => false);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      layer.removeEventListener('load', onLoad);
      layer.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    layer.addEventListener('load', onLoad, { once: true });
    layer.addEventListener('error', onError, { once: true });
    layer.src = url;
    setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
  });
}

// Recursive, not a for-loop: each candidate must be probed in order and the search must stop at
// the first reachable one (a probe has side effects — it sets layer.src on success), so the
// attempts are inherently sequential rather than parallelizable via Promise.all.
async function resolveSlide(layer, startIndex, tries = 0) {
  if (tries >= slides.length) return null;
  const idx = wrap(startIndex + tries);
  const ok = await urlReachable(layer, slides[idx].url);
  if (ok) return idx;
  showSkipped(slides[idx].name);
  return resolveSlide(layer, startIndex, tries + 1);
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
  slides.forEach((slide, i) => {
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

async function primeNext() {
  const idx = await resolveSlide(nextLayer, wrap(current + 1));
  nextLayer.dataset.idx = idx === null ? '' : String(idx);
}

async function commit(index) {
  current = index;
  [currentLayer, nextLayer] = [nextLayer, currentLayer];
  currentLayer.classList.add('active');
  nextLayer.classList.remove('active');
  renderDots();
  await primeNext();
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
    const preloaded = nextLayer.dataset.idx;
    const idx = preloaded !== '' && preloaded !== undefined && Number(preloaded) === target
      ? target
      : await resolveSlide(nextLayer, target);
    if (idx !== null) await commit(idx);
  } finally {
    busy = false;
  }
}

function step(offset) { goTo(current + offset); }

function scheduleRotate() {
  clearTimeout(rotateTimer);
  if (paused || holding) return;
  rotateTimer = setTimeout(() => step(1), slideSeconds() * 1000);
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
  const idx = await resolveSlide(currentLayer, 0);
  current = idx === null ? 0 : idx;
  currentLayer.classList.add('active');
  renderDots();
  scheduleRotate();
  await primeNext();
  scheduleNightlyReload();
}

init();
