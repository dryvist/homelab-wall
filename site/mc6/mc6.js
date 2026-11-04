// Mission Control 6: LEXICON — one word cloud per source (the operator and every AI agent),
// driven by the same-origin /api/words feed (ClickHouse FORMAT JSON). A hero cloud cycles the
// sources every 8s — words shared between consecutive sources glide to their new positions,
// the rest fade — and a strip below keeps one small cloud per source on screen at all times,
// active one highlighted. d3-cloud 2.0.0 places each word synchronously: rasterize a sprite
// with getSprite(), then position it with place() (coordinates centered at 0, rotate in
// degrees); see https://github.com/jasondavies/d3-cloud (v2 README, "Canvas Rendering").
import CloudLayout from '/vendor/d3-cloud/index.js';
import { lastGoodGet, lastGoodSet } from '/lib/lastGood.js';
import { esc, loop, onDispose, setState, adaptiveDpr, loadConfig } from '/lib/stage.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const panel = $('lexicon');

// Per-source colours follow mc3's per-model palette (site/mc3/mc3.js PALETTE) index for
// index over the known sources; anything past it continues down the same palette and wraps.
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];
// Known sources in palette order. Every one of these always gets a strip tile, even when the
// feed has no rows for it yet — an explicit NO FEED state, never stand-in words. Sources that
// only show up later (opencode will; anything else ever) are handled generically: same tile
// treatment, label upper-cased, first-seen slot after the known ones, kept stable across polls.
// Gemini CLI is now AGY (Antigravity): its rows arrive as the antigravity source.
const KNOWN_SOURCES = ['user', 'claude', 'codex', 'antigravity', 'zcode', 'opencode'];
const LABELS = { user: 'OPERATOR', claude: 'CLAUDE', codex: 'CODEX', antigravity: 'AGY', zcode: 'ZCODE', opencode: 'OPENCODE' };
const LABEL = (source) => LABELS[source] || `${source}`.toUpperCase();

const FONT = '"Chakra Petch",sans-serif';
const CYCLE_MS = 8000;     // how long the hero holds one source
const FADE_MS = 1000;      // glide/crossfade window at the start of each cycle
const STALE_MS = 5 * 60 * 1000; // matches mc1's stale label: age, then "since <time>"
const HERO_WORDS = 80;     // top words per source in the hero cloud
const TILE_WORDS = 30;     // top words per source in a strip tile
const WORDS_KEY = 'mc6.words';

const cfg = await loadConfig();

// The feed: ClickHouse FORMAT JSON — {meta, data: [{source, word, n}], rows}. n is a UInt64
// serialized as a STRING; parse with Number().
async function fetchWords() {
  const res = await fetch('/api/words', { cache: 'no-store' });
  if (!res.ok) throw new Error(`words ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.data)) throw new Error('words payload missing data');
  return body.data;
}

/* ---------------- source model ---------------- */
const knownSlot = new Map(); // unknown source name -> stable strip slot (after the known ones)
function slotOf(name) {
  const known = KNOWN_SOURCES.indexOf(name);
  if (known >= 0) return known;
  if (!knownSlot.has(name)) knownSlot.set(name, KNOWN_SOURCES.length + knownSlot.size);
  return knownSlot.get(name);
}
const colorOf = (name) => PALETTE[slotOf(name) % PALETTE.length];

function groupRows(rows) {
  const by = new Map();
  for (const row of rows) {
    const word = String(row?.word ?? '');
    const n = Number(row?.n); // UInt64 arrives as a string
    const name = String(row?.source ?? '');
    if (!word || !name || !Number.isFinite(n)) continue;
    let list = by.get(name);
    if (!list) by.set(name, (list = []));
    list.push({ word, n });
  }
  for (const list of by.values()) list.sort((a, b) => b.n - a.n);
  return by;
}

let sources = []; // [{name, label, color, words}] in strip order
let staleAt = null;
let totalWords = 0;

function apply(rows, heldOver) {
  const by = groupRows(rows);
  for (const name of by.keys()) slotOf(name); // fix unknowns' slots before ordering
  const names = [...new Set([...KNOWN_SOURCES, ...by.keys()])].sort((a, b) => slotOf(a) - slotOf(b));
  sources = names.map((name) => ({ name, label: LABEL(name), color: colorOf(name), words: by.get(name) || [] }));
  totalWords = sources.reduce((sum, s) => sum + s.words.length, 0);
  staleAt = heldOver ?? null;
  panel.classList.toggle('stale', staleAt != null);
  renderSubtitle();
  renderStrip();
  refreshHeroLayouts();
  if (current) markActive(current.source.name); // renderStrip rebuilt the tiles
  // A fresh poll that answers nothing is genuinely empty (state 'empty'); a poll that failed
  // but left us last-good data (lastGood.js) renders it held over (state 'stale', dimmed via
  // mc6.css's stale rule). No data ever and the feed down: stays 'pending'.
  setState(panel, staleAt != null ? 'stale' : totalWords ? 'ok' : 'empty', '');
}

function renderSubtitle() {
  const el = $('subtitle');
  if (staleAt == null) {
    el.textContent = `${sources.length} SOURCES · ${totalWords} WORDS`;
    $('lexsum').textContent = `${sources.filter((s) => s.words.length).length}/${sources.length} FEEDS`;
  } else {
    // mc1's stale label: recent age first, then the absolute time it went quiet.
    el.textContent = Date.now() - staleAt < STALE_MS
      ? `STALE ${ageLabel(staleAt)}`
      : `STALE since ${new Date(staleAt).toTimeString().slice(0, 8)}`;
    $('lexsum').textContent = `STALE`;
  }
}

function ageLabel(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/* ---------------- strip: one small cloud per source, all visible ---------------- */
function renderStrip() {
  const strip = $('strip');
  strip.style.gridTemplateColumns = `repeat(${Math.max(sources.length, 1)},minmax(0,1fr))`;
  // `data-word-source` (not the stand-in convention's `data-source`) names the tile's source.
  strip.innerHTML = sources.map((s) => s.words.length
    ? `<div class="tile" data-word-source="${esc(s.name)}" style="--c:${s.color}"><span class="tlabel">${esc(s.label)}</span><canvas></canvas></div>`
    : `<div class="tile nofeed" data-word-source="${esc(s.name)}" style="--c:${s.color}"><span class="tlabel">${esc(s.label)}</span><span class="tfeed">NO FEED</span></div>`
  ).join('');
  paintTiles();
}

const tileLayouts = new Map(); // source name -> {placed, bounds} at tile scale
function paintTiles() {
  for (const tile of $('strip').children) paintTile(tile);
}

function paintTile(tile) {
  const canvas = tile.querySelector('canvas');
  if (!canvas) return;
  const s = sources.find((x) => x.name === tile.dataset.wordSource);
  if (!s) return;
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(tile.clientWidth * dpr)), h = Math.max(1, Math.round(tile.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; tileLayouts.delete(s.name); }
  const c = canvas.getContext('2d');
  paintBackdrop(c, w, h, s.color);

  // Lay the cloud out in the tile minus the label band at the top, then draw it centered a
  // little below the tile's middle so its top edge clears the label.
  const box = [w, Math.round(h * 0.78)];
  let placed = tileLayouts.get(s.name)?.placed;
  if (!placed) {
    placed = layoutWords(s.words.slice(0, TILE_WORDS), s.name, box, 0.1, 0.3);
    tileLayouts.set(s.name, { placed });
  }
  c.save();
  c.translate(w / 2, h / 2 + Math.round(h * 0.09));
  for (const word of placed) drawWord(c, word, s.color, 1);
  c.restore();
}

// One d3-cloud layout for `words`, font size scaled by sqrt(n) within the source, in a box
// whose height maps 0..1 to the given fractions of h (already in backing pixels).
function layoutWords(words, name, box, minFrac, maxFrac) {
  const [w, h] = box;
  const max = words.reduce((m, x) => Math.max(m, x.n), 1);
  const fmin = Math.max(6, Math.round(h * minFrac)), fmax = Math.max(fmin + 1, Math.round(h * maxFrac));
  const items = words.slice(0, 200).map((x) => ({
    text: x.word,
    n: x.n,
    size: Math.round(fmin + (fmax - fmin) * Math.sqrt(x.n / max)),
  })).sort((a, b) => b.size - a.size);
  const layout = new CloudLayout().size([w, h]).overflow(false);
  const placed = [];
  items.forEach((it, i) => {
    // A word in ten stands vertical; the rest stay horizontal. Rotation is baked into the
    // sprite mask, and the placed word carries it back in degrees for drawing.
    const rotate = i % 10 === 7 ? 90 : 0;
    const sprite = layout.getSprite(it.text, {
      font: FONT, weight: 600, size: it.size, rotate,
      padding: Math.max(1, Math.round(it.size * 0.06)),
    });
    if (!sprite) return;
    const word = layout.place(sprite);
    if (word) placed.push(word);
  });
  return placed;
}

function drawWord(c, word, color, alpha, from) {
  const x = from ? from.x + (word.x - from.x) * from.t : word.x;
  const y = from ? from.y + (word.y - from.y) * from.t : word.y;
  const size = from ? from.size + (word.size - from.size) * from.t : word.size;
  c.save();
  c.globalAlpha = alpha;
  c.translate(x, y);
  c.rotate(word.rotate * Math.PI / 180);
  c.font = `${word.style} ${word.weight} ${word.size}px ${word.font}`;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  // Neon: the glyph in its own colour, haloed by a matching canvas shadow.
  c.shadowColor = color;
  c.shadowBlur = Math.max(4, size * 0.25);
  c.fillStyle = color;
  c.fillText(word.text, 0, 0);
  c.restore();
}

// Faint radial haze in the source's colour — keeps every canvas non-blank even with no words.
function paintBackdrop(c, w, h, color) {
  c.clearRect(0, 0, w, h);
  const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  g.addColorStop(0, hexAlpha(color, 0.1));
  g.addColorStop(1, 'rgba(4,7,12,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

const HEX = /^#([0-9a-f]{6})$/i;
function hexAlpha(hex, a) {
  const m = HEX.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------------- hero: cycles the sources, shared words glide ---------------- */
const hero = $('cloudhero');
const heroBox = $('hero');
let heroSize = [0, 0];
const heroLayouts = new Map(); // source name -> placed[] at hero scale (cleared on any resize/refresh)
// The hero's rotation clock starts on the first frame that has words, so the first source
// always gets a full cycle however long the first /api/words response takes.
let epoch = null;
let lastSlot = -1;
let current = null;  // {source, placed}
let previous = null; // the source the hero is gliding away from, while FADE_MS runs

function fitHero() {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(heroBox.clientWidth * dpr)), h = Math.max(1, Math.round(heroBox.clientHeight * dpr));
  if (hero.width !== w || hero.height !== h) {
    hero.width = w;
    hero.height = h;
    heroSize = [w, h];
    heroLayouts.clear();
    tileLayouts.clear();
    paintTiles();
    current = null;
    previous = null;
    lastSlot = -1;
  }
}

function heroPlaced(source) {
  let placed = heroLayouts.get(source.name);
  if (!placed) {
    placed = layoutWords(source.words.slice(0, HERO_WORDS), source.name, heroSize, 0.016, 0.085);
    heroLayouts.set(source.name, placed);
  }
  return placed;
}

// Recompute the in-flight hero pair in place (words changed under them) from the sources
// apply() has just rebuilt, matched by name. The cycle timer is untouched, so a refresh
// mid-transition keeps gliding — just between the new placements. A source that no longer has
// words is dropped, and when that is the displayed one the next frame picks a slot afresh.
function refreshHeroLayouts() {
  heroLayouts.clear();
  const fresh = (held) => {
    const source = sources.find((s) => s.name === held.source.name);
    return source?.words.length ? { source, placed: heroPlaced(source) } : null;
  };
  if (current) {
    current = fresh(current);
    if (!current) lastSlot = -1;
  }
  if (previous) previous = fresh(previous);
}

const liveSources = () => sources.filter((s) => s.words.length);

function markActive(name) {
  const s = sources.find((x) => x.name === name);
  const el = $('herolabel');
  el.textContent = s ? s.label : '';
  el.style.color = s ? s.color : '';
  for (const tile of $('strip').children) {
    if (tile.dataset.wordSource === name) tile.setAttribute('data-active', '');
    else tile.removeAttribute('data-active');
  }
}

function drawHero(now) {
  fitHero();
  const c = hero.getContext('2d');
  const [w, h] = heroSize;
  const live = liveSources();
  paintBackdrop(c, w, h, current?.source?.color ?? '#3ee6ff');
  if (!live.length) return;
  epoch ??= now;

  const slot = Math.floor((now - epoch) / CYCLE_MS);
  if (slot !== lastSlot) {
    lastSlot = slot;
    const next = live[((slot % live.length) + live.length) % live.length];
    previous = current && current.source !== next ? current : null;
    current = { source: next, placed: heroPlaced(next) };
    markActive(next.name);
  }

  // d3-cloud places words around 0,0 inside the layout box, so draw from the canvas midpoint
  // (paintTile does the same for the strip tiles).
  c.save();
  c.translate(w / 2, h / 2);

  // Transition progress for every mode: reduced motion drops only the positional glide
  // (inside the branch below), never the crossfade itself.
  const t = Math.min(1, ((now - epoch) % CYCLE_MS) / FADE_MS);
  if (previous && t < 1) {
    const ease = 1 - (1 - t) ** 3;
    const from = new Map(previous.placed.map((p) => [p.text, p]));
    const texts = new Set(current.placed.map((p) => p.text));
    // Words in both clouds glide to their new spot; the rest crossfade out/in. With
    // prefers-reduced-motion there is no glide: plain crossfade, positions never lerp.
    for (const p of current.placed) {
      const src = from.get(p.text);
      if (src && !RM) drawWord(c, p, current.source.color, 1, { ...src, t: ease });
      else drawWord(c, p, current.source.color, RM ? t : ease);
    }
    for (const p of previous.placed) {
      if (!texts.has(p.text)) drawWord(c, p, previous.source.color, RM ? 1 - t : 1 - ease);
    }
  } else {
    previous = null;
    for (const p of current.placed) {
      const pulse = RM ? 1 : 0.9 + 0.1 * Math.sin(now / 600 + hash(p.text));
      drawWord(c, p, current.source.color, pulse);
    }
  }
  c.restore();
}

function hash(text) {
  let hsum = 0;
  for (let i = 0; i < text.length; i++) hsum += text.charCodeAt(i);
  return (hsum % 628) / 100;
}

/* ---------------- boot ---------------- */
// The render loop (and the 'ready' postMessage it fires — site/lib/stage.js) starts before the
// first data refresh resolves, so a slow or failing /api/words never delays 'ready' past the
// rotator's probe window.
loop(0, (now) => drawHero(now)); // uncapped: native refresh rate; adaptive quality steps it down

const stripRo = new ResizeObserver(() => paintTiles());
stripRo.observe($('strip'));
onDispose(() => stripRo.disconnect());

async function refresh() {
  let rows = null;
  try {
    rows = await fetchWords();
  } catch {
    const last = lastGoodGet(WORDS_KEY);
    if (last) {
      apply(last.value, last.at);
      return;
    }
    setState(panel, 'pending');
    return;
  }
  lastGoodSet(WORDS_KEY, rows);
  apply(rows, null);
}

await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));

// Sprites rasterize with whatever font the canvas has at that moment; once Chakra Petch has
// actually loaded, re-layout so the clouds are measured (and drawn) in the wall's own face.
document.fonts?.load(`600 16px ${FONT}`).then(() => {
  heroLayouts.clear();
  tileLayouts.clear();
  refreshHeroLayouts();
  paintTiles();
}).catch(() => {});

const tickClock = () => {
  const d = new Date();
  $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`;
  if (staleAt != null) renderSubtitle(); // keep the STALE age ticking
};
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
