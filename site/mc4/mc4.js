// Mission Control 4: media acquisition. Fluid layout — canvases size from their
// own cell (ResizeObserver), never from their own rendered box (site/lib/stage.js
// gains observeCanvas() once fix/mc1-layout-feedback-loop lands; this local
// fitCanvas() is the same pattern and drops out at that rebase).
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { clamp, hue, esc, loadConfig, setState, loop, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct, setSampleBadge } from '/lib/stage.js';
import { sampleAppScore, SAMPLE_ACQ_CARDS, SAMPLE_LIBRARY_CARDS } from '/lib/sampleData.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = cfg.groups || [];
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));

/* ---------------- data ---------------- */
async function refresh() {
  const r = await settle({ score: () => query(Q.appScore) });
  if (r.score) {
    const seen = new Set();
    for (const row of r.score) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 10); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
}

/* ---------------- service health (the page's live panel) ---------------- */
function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  // A query that succeeded with zero rows has genuinely nothing to show yet — render the shared
  // sample scores instead (badged), never layered on top of real (even partial) data.
  const sample = !scored.length;
  const display = apps.map((a, i) => (sample ? { n: a.n, s: sampleAppScore(i) } : a));
  $('approws').innerHTML = display.map((a) => {
    const unk = a.s == null, col = unk ? 'var(--faint)' : hue(scorePct(a.s));
    return `<div class="ar"><span>${esc(a.n)}</span><div class="bar"><div style="width:${unk ? 0 : scorePct(a.s)}%;background:${col};box-shadow:0 0 6px ${col}"></div></div><span class="v num">${unk ? '?' : Math.round(a.s)}</span></div>`;
  }).join('');
  const scores = display.map((a) => a.s).filter((s) => s != null);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length, warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length, bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = scores.length
    ? `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`
    : '';
  setSampleBadge($('apps'), sample);
  setState($('apps'), scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
}

/* ---------------- pending panels — no download/library exporter exists yet ---------------- */
function card(title, note) {
  return `<div class="card"><div class="ct">${esc(title)}</div><div class="cn">${esc(note)}</div></div>`;
}
// No download-client/library exporter exists yet — fixed sample cards, badged, replace the
// single "EXPORTER PENDING" line each panel used to show. Never written into any live model.
$('acqbody').innerHTML = SAMPLE_ACQ_CARDS.map((c) => card(c.title, c.note)).join('');
$('pipebody').innerHTML = SAMPLE_LIBRARY_CARDS.map((c) => card(c.title, c.note)).join('');
setState($('acq'), 'pending', 'DOWNLOAD CLIENT EXPORTER PENDING');
setState($('pipe'), 'pending', 'MEDIA LIBRARY EXPORTER PENDING');
setSampleBadge($('acq'), true);
setSampleBadge($('pipe'), true);
$('vpn').textContent = 'VPN EXPORTER PENDING';

/* ---------------- decorative core (acquisition flow, ambient only) ---------------- */
const core = $('core');
function fitCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
new ResizeObserver(() => fitCanvas(core)).observe(core);
fitCanvas(core);
function drawCore(t) {
  const w = core.width, h = core.height;
  if (!w || !h) return;
  const c = core.getContext('2d');
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.56, base = Math.max(w, h);
  const cols = ['rgba(255,179,71,.28)', 'rgba(56,255,156,.18)', 'rgba(62,230,255,.13)', 'rgba(255,179,71,.09)'];
  cols.forEach((col, i) => {
    const r = base * (0.16 + i * 0.1) + (RM ? 0 : Math.sin(t / 1800 + i) * base * 0.012);
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
  });
  c.fillStyle = 'rgba(255,179,71,.5)'; c.beginPath(); c.arc(cx, cy, base * 0.02, 0, Math.PI * 2); c.fill();
}

/* ---------------- boot ---------------- */
const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock(); setInterval(tickClock, 1000);
await refresh().catch((e) => console.warn('refresh', e));
renderApps();
setInterval(() => refresh().catch((e) => console.warn('refresh', e)).then(() => renderApps()), (cfg.refreshSeconds || 15) * 1000);
loop(30, (now) => drawCore(now));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
