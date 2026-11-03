// Mission Control 3: AI inference core, driven by live litellm_router + Gatus data, the
// accelerator busy recording rule and the same-origin /api/llm/recent request feed.
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import {
  clamp, hue, esc, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct,
  setSampleBadge, onDispose, hardwareGL, adaptiveDpr,
} from '/lib/stage.js';
import { sampleAppScore, SAMPLE_LLM } from '/lib/sampleData.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];

const cfg = await loadConfig();
const groups = (cfg.groups || []).map((g, i) => ({ ...g, c: PALETTE[i % PALETTE.length] }));
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { models: [], tokensToday: null, reqPerMin: null, gpuBusy: null };

async function refresh() {
  const r = await settle({
    score: () => query(Q.appScore),
    state: () => query(Q.llmState),
    tok: () => query(Q.llmTokRate),
    tokensToday: () => query(Q.llmTokensToday),
    reqPerMin: () => query(Q.llmReqPerMin),
    queue: () => query(Q.llmQueueSeconds),
    latency: () => query(Q.llmLatencySeconds),
    gpu: () => query(Q.acceleratorBusy),
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
    const queue = Object.fromEntries((r.queue || []).map((x) => [x.labels.model, x.value]));
    const latency = Object.fromEntries((r.latency || []).map((x) => [x.labels.model, x.value]));
    model.models = r.state.map((x) => {
      const n = x.labels.litellm_model_name;
      return {
        n, up: x.value < 2, tok: tok[n] ?? 0,
        // Both undefined for an idle model (no requests in the window -> no series) — real
        // absence, not a failed query, so it renders a quiet idle state, never a stand-in badge.
        queue: queue[n], latencyMs: Number.isFinite(latency[n]) ? latency[n] * 1000 : undefined,
      };
    }).sort((a, b) => (b.up - a.up) || b.tok - a.tok || a.n.localeCompare(b.n)).slice(0, 8);
  }

  model.tokensToday = Number.isFinite(r.tokensToday?.[0]?.value) ? r.tokensToday[0].value : null;
  model.reqPerMin = Number.isFinite(r.reqPerMin?.[0]?.value) ? r.reqPerMin[0].value : null;
  const busy = (r.gpu || []).map((x) => x.value).filter(Number.isFinite);
  model.gpuBusy = busy.length ? clamp(busy.reduce((x, y) => x + y, 0) / busy.length, 0, 100) : null;
  render();
}

function render() {
  renderApps();
  renderCore();
  renderKpis();
  core3d?.sync(model.models, model.tokensToday);
}

/* ---------------- header ---------------- */
function renderKpis() {
  const up = model.models.filter((m) => m.up).length;
  // Each KPI has its own query and can fail/return nothing independently of the others — a
  // plausible stand-in value per KPI, never the literal "—", marked on that KPI's own element.
  const tokensStandIn = model.tokensToday == null;
  const reqStandIn = model.reqPerMin == null;
  const modelsStandIn = !model.models.length;
  const k = [
    ['tokens today', tokensStandIn ? '4.81' : (model.tokensToday / 1e6).toFixed(2), 'M', tokensStandIn],
    ['requests/min', reqStandIn ? '142' : model.reqPerMin.toFixed(0), '', reqStandIn],
    ['models up', modelsStandIn ? `${SAMPLE_LLM.filter((m) => m.state < 2).length}/${SAMPLE_LLM.length}` : `${up}/${model.models.length}`, '', modelsStandIn],
  ];
  $('kpis').innerHTML = k.map(([l, v, u, standIn]) => `<div class="kpi"><b class="num"${standIn ? ' data-source="stand-in"' : ''}>${v}<i>${u}</i></b><span>${l}</span></div>`).join('');
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
  c.fillText(score == null ? '8' : Math.round(score), cx, cy - H * 0.03);
  c.fillStyle = '#8a5d90'; c.font = `${W * 0.055}px "JetBrains Mono",monospace`; c.fillText('HEALTH', cx, cy + H * 0.14);
}

function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  // A query that succeeded with zero rows has genuinely nothing to show yet — every row falls
  // back to the shared sample scores (badged). When it returns SOME real scores (the common case
  // at scale: a handful of names with no Gatus series among many that do), only the individual
  // apps still missing one fall back to a stand-in score — marked on that row alone (never a
  // whole-panel badge over otherwise-real data), and never the literal "N/A" text.
  const sample = !scored.length;
  const display = apps.map((a, i) => (a.s != null ? { n: a.n, s: a.s, standIn: false } : { n: a.n, s: sampleAppScore(i), standIn: true }));
  const scores = display.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> &middot; <span style="color:var(--amber)">${warn} DEG</span> &middot; <span style="color:var(--red)">${bad} DOWN</span>`;
  $('applist').innerHTML = display.map((a) => `<div class="ar"><i style="background:${hue(scorePct(a.s))}"></i><span>${esc(a.n)}</span><b class="num"${a.standIn ? ' data-source="stand-in"' : ''}>${Math.round(a.s)}</b></div>`).join('');
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
// Queue time and API latency (Q.llmQueueSeconds/Q.llmLatencySeconds, site/lib/queries.js) are real
// per-model averages from litellm's own sum/count metrics — litellm exposes no _bucket histogram,
// so this is an average, not a true p50. A model with no requests in the 5m window (queue/latencyMs
// both undefined on the model object) is genuinely idle, not a failed query: it renders a quiet
// "idle" state, never a stand-in badge.
// Human-readable duration from milliseconds: sub-second as whole ms, sub-minute as one-decimal
// seconds, else minutes — the same three ranges shown across queue time and API latency, so
// both go through this one formatter instead of separate ad-hoc toFixed calls.
function fmtDur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
function modelStats(m) {
  if (!m.up) return { queue: 'offline', avg: 'offline' };
  return {
    queue: m.queue == null ? 'idle' : fmtDur(m.queue * 1000),
    avg: m.latencyMs == null ? 'idle' : fmtDur(m.latencyMs),
  };
}
// Rolling per-model tok/s history for the sparklines (model cards + fleet-health column). Real
// once the router feed answers (each refresh tick appends the live tok value); a brand-new name
// seeds flat at its first-seen value, same technique SAMPLE_LLM.hist already uses, so a sparkline
// never has to fabricate a past it doesn't know.
const HIST_N = 24;
const tokHistory = new Map();
function pushHist(name, tok) {
  let h = tokHistory.get(name);
  if (!h) { h = Array(HIST_N).fill(tok); tokHistory.set(name, h); }
  else { h.push(tok); h.shift(); }
  return h;
}
function drawSpark(canvas, hist, color) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  const max = Math.max(1, ...hist);
  c.beginPath();
  hist.forEach((v, i) => {
    const x = (i / (hist.length - 1)) * w, y = h - (v / max) * (h - 2 * dpr) - dpr;
    i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
  });
  c.strokeStyle = color; c.lineWidth = 1.5 * dpr; c.lineJoin = 'round'; c.stroke();
}

function renderCore() {
  const sample = !model.models.length;
  const list = sample ? SAMPLE_LLM.map((m) => ({ n: m.n, up: m.state < 2, tok: m.tok })) : model.models;
  reactorList = list;
  list.forEach((m) => pushHist(m.n, m.tok));
  const tab = $('modeltab');
  // One row, always: an explicit column count (not auto-fit's width-based wrap) so N models
  // never orphan a lone tile onto a second row. Compact type kicks in once the row is dense
  // enough that auto-fit's old 200px-min columns would have wrapped anyway.
  tab.style.gridTemplateColumns = `repeat(${Math.max(list.length, 1)},minmax(0,1fr))`;
  tab.classList.toggle('dense', list.length > 5);
  tab.innerHTML = list.map((m) => {
    const col = m.up ? (m.tok > 0.05 ? 'var(--green)' : 'var(--cyan)') : 'var(--red)';
    const status = m.up ? 'tok/s' : 'health check failing';
    const { queue, avg } = modelStats(m);
    return `<div class="mc"><div class="mch"><b title="${esc(m.n)}">${esc(m.n.split('/').pop())}</b><span style="color:${col}">${m.up ? 'UP' : 'DOWN'}</span></div>
      <div class="mctok" style="color:${col}">${m.up ? m.tok.toFixed(0) : '0'}<i>${status}</i></div>
      <canvas class="mcspark" data-model="${esc(m.n)}"></canvas>
      <div class="mcbar"><div style="width:${m.up ? clamp(m.tok * 2, 6, 100) : 100}%;background:${col}"></div></div>
      <div class="mcstats">queue <b>${queue}</b> &middot; avg <b>${avg}</b></div></div>`;
  }).join('');
  for (const canvas of $('modeltab').querySelectorAll('.mcspark')) {
    const m = list.find((x) => x.n === canvas.dataset.model);
    drawSpark(canvas, tokHistory.get(m.n) || [0], m.up ? (m.tok > 0.05 ? '#38ff9c' : '#3ee6ff') : '#ff3b5c');
  }
  const up = list.filter((m) => m.up).length;
  $('coresum').textContent = `${up}/${list.length} UP`;
  setSampleBadge($('cores'), sample);
  setState($('cores'), 'ok');
  renderCoreExtra(list);
}

/* ---------------- fleet-health column fill: req/min, GPU/VRAM, sparklines, request feed ------- */
// GPU/VRAM is the mean of the accelerator busy recording rule (Q.acceleratorBusy); with no series
// (or a failed query) the tile says so instead of showing a number. cxReqMin mirrors the real
// header KPI.
function renderCoreExtra(list) {
  $('cxReqMin').textContent = model.reqPerMin != null ? model.reqPerMin.toFixed(0) : '0';

  const gpuPct = model.gpuBusy;
  $('cxGpu').textContent = gpuPct == null ? 'NO FEED' : `${Math.round(gpuPct)}%`;
  $('cxGpu').dataset.feed = gpuPct == null ? 'none' : 'live';
  const gauge = $('gpuGauge'), gc = gauge.getContext('2d');
  const dpr = adaptiveDpr();
  const gw = Math.max(1, Math.round(gauge.clientWidth * dpr)), gh = Math.max(1, Math.round(gauge.clientHeight * dpr));
  if (gauge.width !== gw) gauge.width = gw;
  if (gauge.height !== gh) gauge.height = gh;
  gc.clearRect(0, 0, gw, gh);
  gc.fillStyle = '#200a28'; gc.fillRect(0, 0, gw, gh);
  if (gpuPct != null) { gc.fillStyle = hue(gpuPct); gc.fillRect(0, 0, gw * gpuPct / 100, gh); }

  $('modelSparks').innerHTML = list.map((m) => `<div class="spk"><canvas class="spkc" data-model="${esc(m.n)}"></canvas><b>${esc(m.n.split('/').pop())}</b></div>`).join('');
  for (const canvas of $('modelSparks').querySelectorAll('.spkc')) {
    const m = list.find((x) => x.n === canvas.dataset.model);
    drawSpark(canvas, tokHistory.get(m.n) || [0], m.up ? '#3ee6ff' : '#ff3b5c');
  }
}

/* ---------------- request feed: GET /api/llm/recent ---------------- */
// Metadata rows only ({ts, source, model, role, chars}; never message content), newest first.
// Each row not seen on the previous poll launches a comet from its core to the hub. A failed or
// malformed response clears the feed to an explicit NO FEED state — never invented rows.
const FEED_POLL_MS = 5000;
const FEED_ROWS = 24;
let feedSeen = null;
const rowKey = (r) => `${r.ts}|${r.source}|${r.model}|${r.role}|${r.chars}`;
const fmtChars = (n) => (n < 1000 ? `${n} ch` : `${(n / 1000).toFixed(1)}k ch`);
function feedNotice(state, text) {
  const feed = $('reqfeed');
  feed.dataset.feed = state;
  feed.innerHTML = `<div class="cfrow cfnote">${text}</div>`;
  feedSeen = state === 'none' ? null : new Set();
}
async function pollFeed() {
  let rows;
  try {
    const res = await fetch('/api/llm/recent', { cache: 'no-store' });
    if (!res.ok) throw new Error(`recent ${res.status}`);
    const body = await res.json();
    rows = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(rows)) throw new Error('recent: unexpected body');
  } catch (e) {
    console.warn('llm recent', e);
    feedNotice('none', 'NO FEED');
    return;
  }
  rows = rows.filter((r) => r && typeof r === 'object').sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (!rows.length) { feedNotice('empty', 'NO RECENT REQUESTS'); return; }
  const primed = feedSeen != null;
  const fresh = rows.filter((r) => !feedSeen?.has(rowKey(r)));
  // First load: only the newest few launch comets, staggered, rather than the whole backlog.
  const launch = primed ? fresh : fresh.slice(0, 6);
  launch.slice().reverse().forEach((r, i) => core3d?.comet(r, i * Math.min(600, FEED_POLL_MS / launch.length)));
  const freshKeys = new Set(fresh.map(rowKey));
  const feed = $('reqfeed');
  feed.dataset.feed = 'live';
  feed.innerHTML = rows.slice(0, FEED_ROWS).map((r) => {
    const chars = Math.max(0, Math.round(Number(r.chars) || 0));
    const who = [r.source, String(r.model ?? '').split('/').pop()].filter(Boolean).map(esc).join(' · ');
    return `<div class="cfrow${primed && freshKeys.has(rowKey(r)) ? ' cfrow-in' : ''}"><span>${who}</span><b>${esc(r.role)}</b><b>${fmtChars(chars)}</b></div>`;
  }).join('');
  feedSeen = new Set(rows.map(rowKey));
}

/* ---------------- reactor: WebGPU/TSL hero (core3d.js) or 2D fallback ---------------- */
let reactor = $('reactor');
function fitCanvas(cv) {
  const dpr = adaptiveDpr();
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
  c.fillText(list.length ? `${Math.round(upFrac * 100)}%` : '67%', cx, cy);

  list.forEach((m, i) => {
    const a = (i / Math.max(list.length, 1)) * Math.PI * 2 + t * 0.25;
    const x = cx + Math.cos(a) * R * 1.08, y = cy + Math.sin(a) * R * 1.08 * 0.36;
    c.beginPath(); c.arc(x, y, (m.up ? 4 : 3) * dpr, 0, Math.PI * 2);
    c.fillStyle = m.up ? (m.tok > 0.05 ? '#38ff9c' : '#3ee6ff') : '#ff3b5c';
    c.shadowColor = c.fillStyle; c.shadowBlur = 8 * dpr; c.fill(); c.shadowBlur = 0;
  });
}

/* ---------------- boot ---------------- */
const forced = new URLSearchParams(location.search).get('gl');
let core3d = null;
let drawScene = drawReactor;
let gpuAttempts = 0;
// A canvas that ever held a WebGPU/WebGL context can't hand out a 2D one, so every rebuild or
// fallback starts from a fresh copy of the element.
function freshReactor() {
  const next = reactor.cloneNode(false);
  reactor.replaceWith(next);
  reactor = next;
}
function use2D(reason) {
  if (reason) console.warn('mc3: 2D reactor', reason);
  core3d?.dispose();
  core3d = null;
  freshReactor();
  drawScene = drawReactor;
}
async function startGpuCore() {
  gpuAttempts += 1;
  drawScene = () => {};
  try {
    const { buildGpuCore } = await import('/mc3/core3d.js');
    const core = await buildGpuCore(reactor, {
      palette: PALETTE,
      reducedMotion: RM,
      onLost: () => {
        core.dispose();
        if (core3d === core) core3d = null;
        freshReactor();
        if (gpuAttempts < 3) startGpuCore(); else use2D('GPU device lost repeatedly');
      },
    });
    if (core3d && core3d !== core) core3d.dispose();
    core3d = core;
    core.sync(model.models.length ? model.models : reactorList, model.tokensToday);
    drawScene = (now) => core.render(now);
  } catch (e) {
    use2D(e);
  }
}
if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  startGpuCore();
  onDispose(() => core3d?.dispose());
}

const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
// The render loop (and the 'ready' postMessage it fires — site/lib/stage.js) starts before the
// first data refresh resolves. Gating it behind `await refresh()` is what let a slow/failing
// litellm query on this very page delay 'ready' past the rotator's probe window and get MC3
// skipped as broken on the live wall.
loop(0, (now) => drawScene(now)); // uncapped: native refresh rate, the display has headroom to spare
await refresh().catch((e) => console.warn('refresh', e));
await pollFeed();
const feedId = setInterval(pollFeed, FEED_POLL_MS);
onDispose(() => clearInterval(feedId));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
