// Mission Control 5: pipeline / GitOps overview. Service health is real (Prometheus via
// Q.appScore, same as mc1); GitHub Actions, Terrakube and Semaphore have no metrics feed yet,
// so those panels stay `pending` with an explicit missing-source message (panel contract).
import { query } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { clamp, hue, esc, loadConfig, setState } from '/lib/stage.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c'];

// Size a canvas's backing store from its own cell (never from the canvas's own rendered box —
// that self-reference is what grows a panel without bound), then redraw.
function fitCanvas(cell, canvas, draw) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const apply = () => {
    const w = Math.round(cell.clientWidth * dpr), h = Math.round(cell.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    draw();
  };
  new ResizeObserver(apply).observe(cell);
  apply();
}

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = (cfg.groups || []).map((g, i) => ({ ...g, c: PALETTE[i % PALETTE.length] }));
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { updated: 0 };

async function refresh() {
  let rows = null;
  try { rows = await query(Q.appScore); } catch { rows = null; }
  if (rows) {
    const seen = new Set();
    for (const row of rows) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 100); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
  model.updated = Date.now();
  renderHeader();
  renderApps();
}

/* ---------------- header ---------------- */
function ring(el, score) {
  const c = el.getContext('2d'); c.clearRect(0, 0, 128, 128); c.lineWidth = 10;
  c.strokeStyle = '#171a45'; c.beginPath(); c.arc(64, 64, 52, 0, 7); c.stroke();
  if (score != null) {
    c.strokeStyle = hue(score); c.shadowColor = hue(score); c.shadowBlur = 14;
    c.beginPath(); c.arc(64, 64, 52, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score / 100); c.stroke(); c.shadowBlur = 0;
  }
  c.fillStyle = '#fff'; c.font = '600 34px "Chakra Petch",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(score == null ? '—' : Math.round(score), 64, 60);
  c.fillStyle = '#5d7d90'; c.font = '14px "JetBrains Mono",monospace'; c.fillText('HEALTH', 64, 90);
}
function renderHeader() {
  const scored = apps.filter((a) => a.s != null);
  const avg = scored.length ? scored.reduce((a, x) => a + x.s, 0) / scored.length : null;
  const k = [
    ['repos', esc((cfg.repoCount ?? '—')), ''],
    ['apps', apps.length, ''],
    ['scored', scored.length, `/${apps.length}`],
    ['health', avg != null ? Math.round(avg) : '—', ''],
  ];
  $('kpis').innerHTML = k.map(([l, v, u]) => `<div class="kpi"><b class="num">${v}<i>${u}</i></b><span>${l}</span></div>`).join('');
  $('subtitle').textContent = `${groups.length} GROUPS · ${apps.length} APPS`;
  ring($('ring'), avg);
}

/* ---------------- apps (required ok panel) ---------------- */
function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  const ok = scored.filter((a) => a.s >= 90).length, warn = scored.filter((a) => a.s >= 50 && a.s < 90).length;
  const bad = scored.filter((a) => a.s < 50).length, unk = apps.length - scored.length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>${unk ? ` · <span style="color:var(--dim)">${unk} NO DATA</span>` : ''}`;
  setState($('apps'), scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
  drawAppGrid();
}
function drawAppGrid() {
  const canvas = $('appgrid'), c = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  if (!apps.length) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(apps.length * W / H)));
  const rows = Math.ceil(apps.length / cols);
  const cw = W / cols, ch = H / rows, pad = Math.min(cw, ch) * 0.08;
  apps.forEach((a, i) => {
    const col = i % cols, row = (i / cols) | 0;
    const x = col * cw + pad, y = row * ch + pad, w = cw - pad * 2, h = ch - pad * 2;
    const known = a.s != null, colr = known ? hue(a.s) : '#2a2f77';
    c.fillStyle = known ? colr.replace('55%', '18%') : '#12143a'; c.fillRect(x, y, w, h);
    c.strokeStyle = colr; c.lineWidth = Math.max(1, ch * 0.02); c.strokeRect(x, y, w, h);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = `600 ${Math.max(9, h * 0.32)}px "Chakra Petch",sans-serif`;
    c.fillText(known ? Math.round(a.s) : '?', x + w / 2, y + h * 0.48);
    c.fillStyle = '#9aa3d9'; c.font = `${Math.max(7, h * 0.16)}px "JetBrains Mono",monospace`;
    const label = a.n.length > 10 ? a.n.slice(0, 9) + '…' : a.n;
    c.fillText(label, x + w / 2, y + h * 0.78);
  });
}

/* ---------------- pipeline stage diagram (decorative, no live job data) ---------------- */
const STAGES = ['PR', 'CI', 'MERGE', 'PLAN', 'APPLY', 'CONVERGE', 'LIVE'];
function drawPipeline(canvas) {
  const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  const y = H * 0.55, x0 = W * 0.06, x1 = W * 0.94, n = STAGES.length;
  c.strokeStyle = 'rgba(123,140,255,.35)'; c.lineWidth = Math.max(1, H * 0.006);
  c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
  STAGES.forEach((name, i) => {
    const x = x0 + (x1 - x0) * (i / (n - 1)), col = PALETTE[i % PALETTE.length], r = Math.min(W, H) * 0.03;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = 'rgba(6,7,20,.9)'; c.fill();
    c.strokeStyle = col; c.lineWidth = Math.max(1, r * 0.22); c.shadowColor = col; c.shadowBlur = 10; c.stroke(); c.shadowBlur = 0;
    c.fillStyle = col; c.textAlign = 'center'; c.font = `700 ${Math.max(9, r * 0.6)}px "Chakra Petch",sans-serif`;
    c.fillText(name, x, y - r * 1.6);
  });
}

/* ---------------- boot ---------------- */
setState($('github'), 'pending', 'GITHUB ACTIONS FEED PENDING');
setState($('infra'), 'pending', 'TERRAKUBE / SEMAPHORE FEED PENDING');
setState($('activity'), 'pending', 'PIPELINE EVENT FEED PENDING');
$('github').querySelector('.body').innerHTML = '<div class="pending-row">no CI/CD Prometheus exporter yet</div>';
$('infra').querySelector('.body').innerHTML = '<div class="pending-row">no Terrakube/Semaphore Prometheus exporter yet</div>';
$('activity').querySelector('.body').innerHTML = '<div class="pending-row">no pipeline event feed yet</div>';
setState($('pipeline'), 'pending', 'STAGE STATUS FEED PENDING');
fitCanvas($('pipeline'), $('pipecanvas'), () => drawPipeline($('pipecanvas')));
fitCanvas($('apps'), $('appgrid'), drawAppGrid);

const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock(); setInterval(tickClock, 1000);
await refresh().catch((e) => console.warn('refresh', e));
setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
