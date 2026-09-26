// Mission Control 3: AI inference core, driven by live litellm_router + Gatus data.
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { clamp, hue, esc, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct, setSampleBadge, onDispose } from '/lib/stage.js';
import { sampleAppScore, SAMPLE_LLM } from '/lib/sampleData.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];

const cfg = await loadConfig();
const groups = (cfg.groups || []).map((g, i) => ({ ...g, c: PALETTE[i % PALETTE.length] }));
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { models: [], tokensToday: null, reqPerMin: null };

async function refresh() {
  const r = await settle({
    score: () => query(Q.appScore),
    state: () => query(Q.llmState),
    tok: () => query(Q.llmTokRate),
    tokensToday: () => query(Q.llmTokensToday),
    reqPerMin: () => query(Q.llmReqPerMin),
  });

  if (r.score) {
    const seen = new Set();
    for (const row of r.score) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 10); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }

  if (r.state) {
    const tok = Object.fromEntries((r.tok || []).map((x) => [x.labels.model, x.value]));
    model.models = r.state.map((x) => {
      const n = x.labels.litellm_model_name;
      return { n, up: x.value < 2, tok: tok[n] ?? 0 };
    }).sort((a, b) => (b.up - a.up) || b.tok - a.tok || a.n.localeCompare(b.n)).slice(0, 8);
  }

  model.tokensToday = Number.isFinite(r.tokensToday?.[0]?.value) ? r.tokensToday[0].value : null;
  model.reqPerMin = Number.isFinite(r.reqPerMin?.[0]?.value) ? r.reqPerMin[0].value : null;
  render();
}

function render() {
  renderApps();
  renderCore();
  renderKpis();
}

/* ---------------- header ---------------- */
function renderKpis() {
  const up = model.models.filter((m) => m.up).length;
  const k = [
    ['tokens today', model.tokensToday != null ? (model.tokensToday / 1e6).toFixed(2) : '—', 'M'],
    ['requests/min', model.reqPerMin != null ? model.reqPerMin.toFixed(0) : '—', ''],
    ['models up', model.models.length ? `${up}/${model.models.length}` : '—', ''],
  ];
  $('kpis').innerHTML = k.map(([l, v, u]) => `<div class="kpi"><b class="num">${v}<i>${u}</i></b><span>${l}</span></div>`).join('');
  $('subtitle').textContent = `${apps.length} SERVICES · ${model.models.length} MODELS`;
}

/* ---------------- fleet health (mandatory "apps" panel) ---------------- */
function drawRing(el, score) {
  const c = el.getContext('2d'), W = el.width, H = el.height, cx = W / 2, cy = H / 2, r = W * 0.4;
  c.clearRect(0, 0, W, H); c.lineWidth = W * 0.08;
  c.strokeStyle = '#28102f'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
  if (score != null) {
    c.strokeStyle = hue(scorePct(score)); c.shadowColor = hue(scorePct(score)); c.shadowBlur = W * 0.05;
    c.beginPath(); c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score / 10); c.stroke(); c.shadowBlur = 0;
  }
  c.fillStyle = '#fff'; c.font = `600 ${W * 0.14}px "Chakra Petch",sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(score == null ? 'N/A' : Math.round(score), cx, cy - H * 0.03);
  c.fillStyle = '#8a5d90'; c.font = `${W * 0.055}px "JetBrains Mono",monospace`; c.fillText('HEALTH', cx, cy + H * 0.14);
}

function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  // A query that succeeded with zero rows has genuinely nothing to show yet — render the shared
  // sample scores instead (badged), never layered on top of real (even partial) data.
  const sample = !scored.length;
  const display = apps.map((a, i) => (sample ? { n: a.n, s: sampleAppScore(i) } : a));
  const scores = display.map((a) => a.s).filter((s) => s != null);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> &middot; <span style="color:var(--amber)">${warn} DEG</span> &middot; <span style="color:var(--red)">${bad} DOWN</span>`;
  $('applist').innerHTML = display.map((a) => `<div class="ar"><i style="background:${a.s == null ? 'var(--faint)' : hue(scorePct(a.s))}"></i><span>${esc(a.n)}</span><b class="num">${a.s == null ? 'N/A' : Math.round(a.s)}</b></div>`).join('');
  drawRing($('fleetRing'), scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null);
  setSampleBadge($('apps'), sample);
  setState($('apps'), scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
}

/* ---------------- AI core (models table + reactor) ---------------- */
// The router metrics feed is real (Q.llmState), but has nothing yet on some deployments — the
// shared LLM sample dataset (site/lib/sampleData.js), reshaped to this page's {n,up,tok}, stands
// in instead of a blank/pending table. reactorList mirrors whichever list rendered last, so the
// decorative reactor canvas (drawReactor below) always animates real or stand-in state, never "N/A".
let reactorList = SAMPLE_LLM.map((m) => ({ n: m.n, up: m.state < 2, tok: m.tok }));
function renderCore() {
  const sample = !model.models.length;
  const list = sample ? SAMPLE_LLM.map((m) => ({ n: m.n, up: m.state < 2, tok: m.tok })) : model.models;
  reactorList = list;
  $('modeltab').innerHTML = list.map((m) => {
    const col = m.up ? (m.tok > 0.05 ? 'var(--green)' : 'var(--cyan)') : 'var(--red)';
    const status = m.up ? (m.tok > 0.05 ? `${m.tok.toFixed(0)} tok/s` : 'idle') : 'health check failing';
    return `<div class="mc"><div class="mch"><b title="${esc(m.n)}">${esc(m.n.split('/').pop())}</b><span style="color:${col}">${m.up ? 'UP' : 'DOWN'}</span></div>
      <div class="mcv">${status}</div>
      <div class="mcbar"><div style="width:${m.up ? clamp(m.tok * 2, 6, 100) : 100}%;background:${col}"></div></div></div>`;
  }).join('');
  const up = list.filter((m) => m.up).length;
  $('coresum').textContent = `${up}/${list.length} UP`;
  setSampleBadge($('cores'), sample);
  setState($('cores'), 'ok');
}

/* ---------------- reactor canvas: orbiting rings + per-model status points ---------------- */
const reactor = $('reactor');
function fitCanvas(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}
function drawReactor(now) {
  const dpr = fitCanvas(reactor);
  const c = reactor.getContext('2d'), W = reactor.width, H = reactor.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3;
  c.clearRect(0, 0, W, H);
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 2.2);
  g.addColorStop(0, 'rgba(255,79,216,.10)'); g.addColorStop(1, 'rgba(4,3,8,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);

  const list = reactorList;
  const upFrac = list.length ? list.filter((m) => m.up).length / list.length : 0;
  const col = list.length ? hue(upFrac * 100) : '#3a2440';
  const t = RM ? 0 : now / 1000;

  for (let i = 0; i < 6; i++) {
    const rr = R * (0.5 + i * 0.11), rot = t * (0.12 + i * 0.04) * (i % 2 ? -1 : 1);
    c.save(); c.translate(cx, cy); c.rotate(rot); c.scale(1, 0.36);
    c.beginPath(); c.arc(0, 0, rr, 0, Math.PI * 2);
    c.strokeStyle = col; c.globalAlpha = 0.8 - i * 0.1; c.lineWidth = 2 * dpr; c.stroke();
    c.restore();
  }

  c.beginPath(); c.arc(cx, cy, R * 0.22, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,.08)'; c.fill();
  c.globalAlpha = 0.9; c.strokeStyle = '#fff'; c.lineWidth = 1.5 * dpr; c.stroke(); c.globalAlpha = 1;
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `600 ${R * 0.24}px "Chakra Petch",sans-serif`;
  c.fillText(list.length ? `${Math.round(upFrac * 100)}%` : 'N/A', cx, cy);

  list.forEach((m, i) => {
    const a = (i / Math.max(list.length, 1)) * Math.PI * 2 + t * 0.25;
    const x = cx + Math.cos(a) * R * 1.08, y = cy + Math.sin(a) * R * 1.08 * 0.36;
    c.beginPath(); c.arc(x, y, (m.up ? 4 : 3) * dpr, 0, Math.PI * 2);
    c.fillStyle = m.up ? (m.tok > 0.05 ? '#38ff9c' : '#3ee6ff') : '#ff3b5c';
    c.shadowColor = c.fillStyle; c.shadowBlur = 8 * dpr; c.fill(); c.shadowBlur = 0;
  });
}

/* ---------------- boot ---------------- */
const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
loop(30, (now) => drawReactor(now));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
