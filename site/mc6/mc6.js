// Mission Control 6: LEXICON — one word cloud per source (the operator and every AI agent),
// driven by the same-origin /api/words feed (ClickHouse FORMAT JSON). A hero cloud cycles the
// sources every 8s and a strip below keeps one small cloud per source on screen, active one
// highlighted. Each cloud is laid out with d3-cloud 2.0.0 once per data refresh: every word is
// rasterised with getSprite() (family, weight, size and angle chosen per word) and then placed
// with place() (coordinates centred at 0, rotate in degrees); see
// https://github.com/jasondavies/d3-cloud (v2 README, "Canvas Rendering").
import CloudLayout from '/vendor/d3-cloud/index.js';
import { lastGoodGet, lastGoodSet } from '/lib/lastGood.js';
import { esc, loop, onDispose, setState, adaptiveDpr, loadConfig } from '/lib/stage.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const panel = $('lexicon');
const TAU = Math.PI * 2;

// Per-source colours follow mc3's per-model palette (site/mc3/mc3.js PALETTE) index for
// index over the known sources; anything past it continues down the same palette and wraps.
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];
// Known sources in palette order. Every one of these always gets a strip tile, even when the
// feed has no rows for it yet — an explicit NO FEED state, never stand-in words. Sources that
// only show up later are handled generically: same tile treatment, label upper-cased, first-seen
// slot after the known ones, kept stable across polls.
// Gemini CLI is now AGY (Antigravity): its rows arrive as the antigravity source.
const KNOWN_SOURCES = ['user', 'claude', 'codex', 'antigravity', 'zcode', 'opencode'];
const LABELS = { user: 'OPERATOR', claude: 'CLAUDE', codex: 'CODEX', antigravity: 'AGY', zcode: 'ZCODE', opencode: 'OPENCODE' };
const LABEL = (source) => LABELS[source] || `${source}`.toUpperCase();

// Chakra Petch carries the display tiers and JetBrains Mono the tail. wall.css declares the faces;
// each one is loaded before the first layout, since d3-cloud measures text with the faces present.
const DISPLAY = '"Chakra Petch",sans-serif';
const MONO = '"JetBrains Mono",monospace';
const FACES = [`700 16px ${DISPLAY}`, `600 16px ${DISPLAY}`, `400 16px ${DISPLAY}`, `600 16px ${MONO}`, `400 16px ${MONO}`];

const CYCLE_MS = 8000;     // how long the hero holds one source
const FADE_MS = 1000;      // glide/crossfade window at the start of each cycle
const STALE_MS = 5 * 60 * 1000; // matches mc1's stale label: age, then "since <time>"
const HERO_WORDS = 80;     // top words per source in the hero cloud
const TILE_WORDS = 30;     // top words per source in a strip tile
const CONVERGENCE_WORDS = 120; // top words of the merged view, by total n across sources
const VOCAB_OUTLINE = 'rgba(232,244,255,0.85)'; // outline on words shared by the operator and an agent
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

// A palette colour as [hue in degrees, saturation in percent]: the hue every word of that source keeps.
function hueSat(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return [0, 0];
  const l = (max + min) / 2;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100];
}

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

let sources = [];          // [{name, label, color, base, words}] in strip order; base = hueSat(color)
let shareMap = new Map();  // word -> [{source, base, n}] for every source holding the word, strip order
let staleAt = null;
let totalWords = 0;

function apply(rows, heldOver) {
  const by = groupRows(rows);
  for (const name of by.keys()) slotOf(name); // fix unknowns' slots before ordering
  const names = [...new Set([...KNOWN_SOURCES, ...by.keys()])].sort((a, b) => slotOf(a) - slotOf(b));
  sources = names.map((name) => ({ name, label: LABEL(name), color: colorOf(name), base: hueSat(colorOf(name)), words: by.get(name) || [] }));
  shareMap = new Map();
  for (const s of sources) {
    for (const w of s.words) {
      let mix = shareMap.get(w.word);
      if (!mix) shareMap.set(w.word, (mix = []));
      mix.push({ source: s.name, base: s.base, n: w.n });
    }
  }
  totalWords = sources.reduce((sum, s) => sum + s.words.length, 0);
  staleAt = heldOver ?? null;
  panel.classList.toggle('stale', staleAt != null);
  renderSubtitle();
  renderShared();
  tileLayouts.clear();
  renderStrip();
  refreshHeroLayouts();
  markActive(current?.view ?? null);
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

// Words held by more than one source, most frequent overall first.
function renderShared() {
  const shared = [...shareMap].filter(([, mix]) => mix.length > 1).sort(([, a], [, b]) => totalOf(b) - totalOf(a));
  $('shared').textContent = shared.length ? `SHARED ${shared.length} · ${shared.slice(0, 4).map(([word]) => word).join(' · ')}` : '';
}

const totalOf = (mix) => mix.reduce((sum, m) => sum + m.n, 0);

function ageLabel(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/* ---------------- word typography and colour ---------------- */
// The i-th of n words (ranked by n) sits in tier 0 for the top 5%, tier 1 up to the top 20%,
// tier 2 up to the top half, and tier 3 for the tail.
function tierOf(i, n) {
  if (i < Math.max(1, Math.round(n * 0.05))) return 0;
  if (i < Math.round(n * 0.2)) return 1;
  if (i < Math.round(n * 0.5)) return 2;
  return 3;
}

// Family, weight and angle by tier: Chakra Petch 700, 600 and 400 up the cloud, JetBrains Mono
// 600 then 400 in the tail. Angles are 0 except for a few slightly tilted words and one tail word
// in nine set vertical (90°).
function faceOf(tier, i, n) {
  if (tier === 0) return { family: DISPLAY, weight: 700, rotate: 0 };
  if (tier === 1) return { family: DISPLAY, weight: 600, rotate: i % 5 === 3 ? -4 : 0 };
  if (tier === 2) return { family: DISPLAY, weight: 400, rotate: i % 6 === 4 ? 3 : 0 };
  return { family: MONO, weight: i < n * 0.8 ? 600 : 400, rotate: i % 9 === 7 ? 90 : i % 7 === 2 ? -6 : 0 };
}

// A word's colour: the source's hue, moving from -8° at the top of the cloud to +8° at the tail,
// with saturation and lightness falling as t goes from 0 (top word) to 1 (tail).
function shade([hue, sat], t) {
  return `hsl(${(hue + 16 * t - 8).toFixed(1)} ${(sat * (1 - 0.45 * t)).toFixed(1)}% ${(82 - 42 * t).toFixed(1)}%)`;
}

// A word's fill inside one source's cloud: its own shade, or a gradient across the shade of every
// source holding that word. Only the hero's gradients sheen.
function sourcePaint(item, t, hero) {
  const mix = item.mix;
  if (mix.length === 1) return { color: shade(mix[0].base, t) };
  const last = mix.length - 1;
  return { color: shade(mix[0].base, t), stops: mix.map((m, j) => [j / last, shade(m.base, t)]), sheen: hero };
}

// A stable pseudo-random fraction in [0, 1) for a string (FNV-1a): a word always gets the same
// sheen phase.
function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const measurer = document.createElement('canvas').getContext('2d');
function widthOf(text, face, size) {
  measurer.font = `${face.weight} ${size}px ${face.family}`;
  return measurer.measureText(text).width;
}

// The words of one source as layout items, each carrying every source's entry for the same text.
function sourceItems(source, cap) {
  return source.words.slice(0, cap).map((w) => ({ word: w.word, n: w.n, mix: shareMap.get(w.word) }));
}

// Words held by both the operator (user) and at least one agent: the shared vocabulary.
const isVocab = (mix) => mix.some((m) => m.source === 'user') && mix.some((m) => m.source !== 'user');

// Every word of every source, sized by its total n across sources, largest first.
function mergedItems() {
  const items = [];
  for (const [word, mix] of shareMap) {
    const total = totalOf(mix);
    items.push({ word, n: total, total, mix, vocab: isVocab(mix) });
  }
  return items.sort((a, b) => b.n - a.n).slice(0, CONVERGENCE_WORDS);
}

// A merged word is one segment per source holding it, each as wide as that source's share of the
// word's total n. The glyphs fill with the segments left to right, and an underline repeats them.
function mergedPaint(item, t) {
  const segments = item.mix.map((m) => ({ share: m.n / item.total, color: shade(m.base, t) }));
  const paint = { color: segments[0].color, segments };
  if (segments.length > 1) paint.stops = hardStops(segments);
  return paint;
}

// Gradient stops that hold each segment's colour across its share, with hard edges between shares.
function hardStops(segments) {
  const stops = [];
  let at = 0;
  for (const seg of segments) {
    stops.push([at, seg.color]);
    at = Math.min(1, at + seg.share);
    stops.push([at, seg.color]);
  }
  return stops;
}

// One d3-cloud layout for `items`, sorted by n descending. Font size scales with sqrt(n) between
// the two box fractions. Each word is rasterised and placed once; the result keeps the word's
// paint, its advance width and its sheen phase next to d3-cloud's own fields.
function layoutCloud(items, [w, h], [minFrac, maxFrac], paintFor, hero) {
  const max = items.reduce((m, x) => Math.max(m, x.n), 1);
  const fmin = Math.max(6, Math.round(h * minFrac)), fmax = Math.max(fmin + 1, Math.round(h * maxFrac));
  const layout = new CloudLayout().size([w, h]).overflow(false);
  const placed = [];
  items.forEach((it, i) => {
    const tier = tierOf(i, items.length);
    const face = faceOf(tier, i, items.length);
    const size = Math.round(fmin + (fmax - fmin) * Math.sqrt(it.n / max));
    const sprite = layout.getSprite(it.word, {
      font: face.family, weight: face.weight, size, rotate: face.rotate,
      padding: Math.max(1, Math.round(size * 0.06)),
    });
    const word = sprite && layout.place(sprite);
    if (!word) return;
    const paint = paintFor(it, items.length > 1 ? i / (items.length - 1) : 0, hero);
    placed.push({
      ...word,
      paint,
      primary: paint.color,
      tw: widthOf(it.word, face, size),
      halo: hero && (tier === 0 || !!it.vocab),
      vocab: hero && !!it.vocab,
      phase: hashOf(it.word) * TAU,
    });
  });
  return placed;
}

// Where a placed word is drawn: its own position, angle, size and alpha.
const at = (word, alpha = 1) => ({ x: word.x, y: word.y, rot: word.rotate, size: word.size, alpha });

// A gradient fill spans the word's advance width; a sheening one slides back and forth over time.
function fillOf(c, word, hw, now) {
  const paint = word.paint;
  if (!paint.stops) return paint.color;
  const shift = paint.sheen && now ? hw * 0.8 * Math.sin(now / 1900 + word.phase) : 0;
  const g = c.createLinearGradient(-hw + shift, 0, hw + shift, 0);
  for (const [offset, color] of paint.stops) g.addColorStop(offset, color);
  return g;
}

// Paints one placed word at geo = {x, y, rot, size, alpha}. The glyphs are scaled from the word's
// own width, so a size lerp during a transition keeps the advance width consistent.
function drawWord(c, word, geo, now) {
  const hw = (word.tw * geo.size / word.size) / 2;
  c.save();
  c.globalAlpha = geo.alpha;
  c.translate(geo.x, geo.y);
  c.rotate(geo.rot * Math.PI / 180);
  c.font = `${word.style} ${word.weight} ${geo.size}px ${word.font}`;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  if (word.halo) {
    c.shadowColor = word.primary;
    c.shadowBlur = Math.max(4, geo.size * 0.35);
  }
  c.fillStyle = fillOf(c, word, hw, now);
  c.fillText(word.text, 0, 0);
  c.shadowBlur = 0;
  if (word.vocab) {
    c.lineWidth = Math.max(1, geo.size * 0.035);
    c.strokeStyle = VOCAB_OUTLINE;
    c.strokeText(word.text, 0, 0);
  }
  if (word.paint.segments) {
    // Underline: each source's share of the word, in that source's shade.
    const y = geo.size * 0.14, th = Math.max(1.5, geo.size * 0.05);
    let x = -hw;
    for (const seg of word.paint.segments) {
      const sw = 2 * hw * seg.share;
      c.fillStyle = seg.color;
      c.fillRect(x, y, sw, th);
      x += sw;
    }
  }
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

/* ---------------- strip: one small cloud per source, all visible ---------------- */
// `data-word-source` (not the stand-in convention's `data-source`) names the tile's source.
function renderStrip() {
  const strip = $('strip');
  strip.style.gridTemplateColumns = `repeat(${Math.max(sources.length, 1)},minmax(0,1fr))`;
  strip.innerHTML = sources.map((s) => s.words.length
    ? `<div class="tile" data-word-source="${esc(s.name)}" style="--c:${s.color}"><span class="tlabel">${esc(s.label)}</span><canvas></canvas></div>`
    : `<div class="tile nofeed" data-word-source="${esc(s.name)}" style="--c:${s.color}"><span class="tlabel">${esc(s.label)}</span><span class="tfeed">NO FEED</span></div>`
  ).join('');
  paintTiles();
}

const tileLayouts = new Map(); // source name -> {placed} at tile scale
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
    placed = layoutCloud(sourceItems(s, TILE_WORDS), box, [0.1, 0.3], sourcePaint, false);
    tileLayouts.set(s.name, { placed });
  }
  c.save();
  c.translate(w / 2, h / 2 + Math.round(h * 0.09));
  for (const word of placed) drawWord(c, word, at(word), 0);
  c.restore();
}

/* ---------------- hero: cycles the sources, shared words glide ---------------- */
const hero = $('cloudhero');
const heroBox = $('hero');
let heroSize = [0, 0];
const heroLayouts = new Map(); // view key -> placed[] at hero scale (cleared on any resize/refresh)
// The hero's rotation clock starts on the first frame that has words, so the first source
// always gets a full cycle however long the first /api/words response takes.
let epoch = null;
let lastSlot = -1;
let current = null;  // {view, placed}
let previous = null; // the view the hero is gliding away from, while FADE_MS runs

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

// The hero rotation: every source that has words, in strip order, then the merged view.
const MERGED = Symbol('convergence');
const MERGED_VIEW = { key: MERGED, label: 'CONVERGENCE', color: '', source: null };
function liveViews() {
  const live = sources.filter((s) => s.words.length).map((s) => ({ key: s.name, label: s.label, color: s.color, source: s }));
  return live.length ? [...live, MERGED_VIEW] : [];
}

function viewOf(key) {
  return liveViews().find((v) => v.key === key) ?? null;
}

function heroPlaced(view) {
  let placed = heroLayouts.get(view.key);
  if (!placed) {
    placed = view.source
      ? layoutCloud(sourceItems(view.source, HERO_WORDS), heroSize, [0.016, 0.085], sourcePaint, true)
      : layoutCloud(mergedItems(), heroSize, [0.016, 0.085], mergedPaint, true);
    heroLayouts.set(view.key, placed);
  }
  return placed;
}

// Re-lay the in-flight hero pair from the sources apply() has just rebuilt, matched by key. The
// cycle timer is untouched, so a refresh mid-transition keeps gliding between the new placements.
// A view that no longer has words is dropped, and when that is the displayed one the next frame
// picks a slot afresh.
function refreshHeroLayouts() {
  heroLayouts.clear();
  const fresh = (held) => {
    const view = viewOf(held.view.key);
    return view ? { view, placed: heroPlaced(view) } : null;
  };
  if (current) {
    current = fresh(current);
    if (!current) lastSlot = -1;
  }
  if (previous) previous = fresh(previous);
}

function markActive(view) {
  const el = $('herolabel');
  el.textContent = view ? view.label : '';
  el.style.color = view?.color ?? '';
  el.classList.toggle('merged', view?.key === MERGED);
  $('herosub').textContent = heroSub(view);
  for (const tile of $('strip').children) {
    if (view && tile.dataset.wordSource === view.key) tile.setAttribute('data-active', '');
    else tile.removeAttribute('data-active');
  }
}

// The line under the hero label: a source's shown words out of its total, or for the merged view
// the distinct terms and the shared vocabulary, most frequent first.
function heroSub(view) {
  if (!view) return '';
  if (view.source) return `${Math.min(view.source.words.length, HERO_WORDS)} OF ${view.source.words.length} WORDS`;
  const vocab = [...shareMap].filter(([, mix]) => isVocab(mix)).sort(([, a], [, b]) => totalOf(b) - totalOf(a)).map(([word]) => word);
  const head = `${shareMap.size} TERMS`;
  return vocab.length ? `${head} · SHARED VOCAB ${vocab.slice(0, 5).join(' · ')}` : `${head} · NO SHARED VOCAB`;
}

// Slow breathing scale and drift of the whole hero cloud, a percent or so and a few pixels, so a
// static cloud never looks frozen. Each value is a function of the frame time alone.
function idleMotion(now) {
  if (RM) return { x: 0, y: 0, s: 1 };
  const T = now / 1000;
  return { x: 6 * Math.sin(T * TAU / 27), y: 4 * Math.sin(T * TAU / 19 + 1), s: 1 + 0.012 * Math.sin(T * TAU / 11) };
}

// A word in both layouts: its glyphs glide from the old spot to the new one, resizing and turning
// on the way, while its old paint fades out and its new paint fades in. Reduced motion keeps each
// word in its own spot and only crossfades.
function morph(c, a, b, e, now) {
  if (RM) {
    drawWord(c, a, at(a, 1 - e), now);
    drawWord(c, b, at(b, e), now);
    return;
  }
  const geo = {
    x: a.x + (b.x - a.x) * e,
    y: a.y + (b.y - a.y) * e,
    rot: a.rotate + (b.rotate - a.rotate) * e,
    size: a.size + (b.size - a.size) * e,
  };
  drawWord(c, a, { ...geo, alpha: 1 - e }, now);
  drawWord(c, b, { ...geo, alpha: e }, now);
}

function drawTransition(c, from, to, ease, now) {
  const before = new Map(from.map((p) => [p.text, p]));
  const after = new Set(to.map((p) => p.text));
  for (const p of to) {
    const src = before.get(p.text);
    if (src) morph(c, src, p, ease, now);
    else drawWord(c, p, at(p, ease), now);
  }
  for (const p of from) {
    if (!after.has(p.text)) drawWord(c, p, at(p, 1 - ease), now);
  }
}

function drawSteady(c, placed, now) {
  for (const word of placed) {
    const pulse = RM || !word.halo ? 1 : 0.92 + 0.08 * Math.sin(now / 900 + word.phase);
    drawWord(c, word, at(word, pulse), now);
  }
}

function drawHero(now) {
  fitHero();
  const c = hero.getContext('2d');
  const [w, h] = heroSize;
  const list = liveViews();
  paintBackdrop(c, w, h, current?.view.color || '#3ee6ff');
  if (!list.length) return;
  epoch ??= now;

  const slot = Math.floor((now - epoch) / CYCLE_MS);
  if (slot !== lastSlot) {
    lastSlot = slot;
    const next = list[((slot % list.length) + list.length) % list.length];
    previous = current && current.view.key !== next.key ? current : null;
    current = { view: next, placed: heroPlaced(next) };
    markActive(next);
  }

  // d3-cloud places words around 0,0 inside the layout box, so draw from the canvas midpoint
  // (paintTile does the same for the strip tiles).
  const t = Math.min(1, ((now - epoch) % CYCLE_MS) / FADE_MS);
  const idle = idleMotion(now);
  c.save();
  c.translate(w / 2 + idle.x, h / 2 + idle.y);
  c.scale(idle.s, idle.s);
  if (previous && t < 1) {
    drawTransition(c, previous.placed, current.placed, 1 - (1 - t) ** 3, now);
  } else {
    previous = null;
    drawSteady(c, current.placed, now);
  }
  c.restore();
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

// Every face is loaded before the first layout: d3-cloud measures each word with the face it is
// drawn in, so a layout made before the faces arrive would be sized for the fallback.
await Promise.all(FACES.map((face) => document.fonts?.load(face))).catch(() => {});
await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));

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
