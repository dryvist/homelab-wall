// Mission Control 4: media acquisition. Fluid layout — canvases size from their
// own cell (ResizeObserver), never from their own rendered box (site/lib/stage.js
// gains observeCanvas() once fix/mc1-layout-feedback-loop lands; this local
// fitCanvas() is the same pattern and drops out at that rebase).
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { clamp, hue, esc, loadConfig, setState, loop } from '/lib/stage.js';

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
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 100); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
}

/* ---------------- service health (the page's live panel) ---------------- */
function renderApps() {
  $('approws').innerHTML = apps.map((a) => {
    const unk = a.s == null, col = unk ? 'var(--faint)' : hue(a.s);
    return `<div class="ar"><span>${esc(a.n)}</span><div class="bar"><div style="width:${unk ? 0 : a.s}%;background:${col};box-shadow:0 0 6px ${col}"></div></div><span class="v num">${unk ? '?' : Math.round(a.s)}</span></div>`;
  }).join('');
  const scored = apps.filter((a) => a.s != null);
  const ok = scored.filter((a) => a.s >= 90).length, warn = scored.filter((a) => a.s >= 50 && a.s < 90).length, bad = scored.filter((a) => a.s < 50).length;
  $('appsum').innerHTML = scored.length
    ? `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`
    : '';
  setState($('apps'), scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
}

/* ---------------- pending panels — no download/library exporter exists yet ---------------- */
function card(title, note) {
  return `<div class="card"><div class="ct">${esc(title)}</div><div class="cn">${esc(note)}</div></div>`;
}
$('acqbody').innerHTML = [card('QBITTORRENT', 'DOWNLOAD CLIENT EXPORTER PENDING'), card('VPN TUNNEL', 'DOWNLOAD-VPN EXPORTER PENDING')].join('');
$('pipebody').innerHTML = [card('PLEX', 'MEDIA SERVER EXPORTER PENDING'), card('ARR STACK', 'ARR EXPORTER PENDING'), card('LIBRARY STORAGE', 'LIBRARY STORAGE METRICS PENDING')].join('');
setState($('acq'), 'pending', 'DOWNLOAD CLIENT EXPORTER PENDING');
setState($('pipe'), 'pending', 'MEDIA LIBRARY EXPORTER PENDING');
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
