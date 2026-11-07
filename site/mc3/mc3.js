// Mission Control 3: AI inference core, driven by live litellm_router + Gatus data, the accelerator
// busy and device queries (Q.acceleratorBusy, Q.gpuModel, Q.macChip), the router's request counts
// and per-request percentiles, and the same-origin /api/llm/recent request feed. Four device anchors
// and a cloud node are always drawn; each model hangs off the anchor of the device that serves it.
import { query, settle } from '/lib/prom.js';
import { guardRefresh } from '/lib/refresh.js';
import { Q } from '/lib/queries.js';
import { listedModels, perfReader, perfCard } from '/lib/modelPerf.js';
import { assignModelColors, billingClassValues, classPair, modelCounts, modelCountPair, shortDevice } from '/lib/mc3.js';
import {
  clamp, hue, esc, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct,
  onDispose, hardwareGL, adaptiveDpr,
} from '/lib/stage.js';
import { createPointer } from '/lib/pointer.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const { pointer, dispose: disposePointer } = createPointer();
onDispose(disposePointer);
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];

setState($('apps'), 'pending', 'WAITING FOR SCORE DATA');
setState($('cores'), 'pending', 'WAITING FOR MODEL DATA');
const cfg = await loadConfig();

/* ---------------- accelerator anchors: layout, naming, attachment ---------------- */
// Four device roles (the `accelerator` label of Q.acceleratorBusy) and the cloud node. `angle` is each
// anchor's place on the ellipse around the hub, in screen degrees (0 = right, 90 = down). layoutAnchors
// turns it into a CSS-px point, and the 3D scene and the 2D fallback both draw from those points.
const ANCHOR_DEFS = [
  { id: 'gpu-primary', kind: 'gpu', angle: 160 },
  { id: 'gpu-secondary', kind: 'gpu', angle: 110 },
  { id: 'mac-primary', kind: 'mac', angle: 70 },
  { id: 'mac-secondary', kind: 'mac', angle: 20 },
  { id: 'cloud', kind: 'cloud', angle: 300 },
];
// Label box under each node: LABEL_W wide, LABEL_TOP below the node's centre (.alab in mc3.css), LABEL_H tall.
const LABEL_W = 320, LABEL_TOP = 40, LABEL_H = 84, EDGE = 16;
let slots = ANCHOR_DEFS.map(() => ({ x: 0, y: 0 })); // CSS-px node points, set by layoutAnchors
const CLOUD = ANCHOR_DEFS.length - 1;
const ROLE = new Map(ANCHOR_DEFS.slice(0, CLOUD).map((d, i) => [d.id, i]));
// Mirrors site/mc3/core3d.js: requests are drawn one bead each up to BEAD_RING, packed into rings
// up to BEAD_CAP drawn beads past that, and the badge carries the true count.
const BEAD_RING = 12;
const BEAD_CAP = 36;
const ANCHOR_COLOR = { gpu: '#3ee6ff', mac: '#38ff9c', cloud: '#ffb347' };
// The host of a "host:port" instance label or a "scheme://host:port/path" serving URL. A bracketed IPv6
// address ("[fd00::1]:8000") is read whole, so distinct IPv6 hosts stay distinct.
const hostOf = (s) => {
  const rest = String(s ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const v6 = rest.match(/^\[([^\]]*)\]/);
  return (v6 ? v6[1] : rest.split(/[/:]/)[0]).toLowerCase();
};
// Dim when nothing is attached or in flight; an accelerator without a busy series is always dim.
const isDim = (d) => (d.kind === 'cloud' ? (d.active == null || d.active === 0) && d.models === 0 : d.busy == null || (d.models === 0 && d.active === 0));
// /config.json may override an anchor's display name; a missing or blank entry keeps the label.
const overrides = cfg.accelerators && typeof cfg.accelerators === 'object' ? cfg.accelerators : {};

// listFailed: Q.llmUsed4d failed, so models lists every deployment (site/lib/modelPerf.js).
const model = {
  models: [], listFailed: false, stateFailed: false, tokensToday: { local: null, cloud: null }, reqPerMin: { local: null, cloud: null },
  modelCounts: null, active: { local: null, cloud: null }, gpuBusy: null, gpuFailed: false,
};
// Fleet list: the AI-category services and their 0-10 scores (Q.aiAppScore), sorted by name.
let aiApps = [];
let appScoreFailed = false;
// Anchor state, rebuilt on every refresh: name, busy % (null when its busy series is absent),
// active requests and attached model count.
let accel = ANCHOR_DEFS.map((d) => ({ ...d, name: d.id, busy: null, active: 0, models: 0 }));

async function refresh() {
  const r = await settle({
    score: () => query(Q.aiAppScore),
    state: () => query(Q.llmState),
    used: () => query(Q.llmUsed4d),
    localModels: () => query(Q.llmLocalModels),
    // The 5m output rate drives the scene's streams only; the cards read per-request readings.
    tok: () => query(Q.routerOutput),
    requests: () => query(Q.llmRequests1h),
    requestP50: () => query(Q.llmRequestP50),
    requestP90: () => query(Q.llmRequestP90),
    requestP99: () => query(Q.llmRequestP99),
    ttftP50: () => query(Q.llmTtftP50),
    decodeP50: () => query(Q.llmDecodeP50),
    decodeP90: () => query(Q.llmDecodeP90),
    decodeP99: () => query(Q.llmDecodeP99),
    lastRequest: () => query(Q.llmLastRequest),
    tokensToday: () => query(Q.llmTokensToday),
    reqPerMin: () => query(Q.llmReqPerMin),
    gpu: () => query(Q.acceleratorBusy),
    gpuModel: () => query(Q.gpuModel),
    macChip: () => query(Q.macChip),
    apiBase: () => query(Q.llmApiBase),
    vllm: () => query(Q.vllmRunning),
    llama: () => query(Q.llamaRunning),
    inflight: () => query(Q.routerInFlight),
  });

  appScoreFailed = r.score === null;
  if (r.score !== null) {
    aiApps = r.score
      .filter((row) => row.labels.name && Number.isFinite(row.value))
      .map((row) => ({ n: row.labels.name, s: clamp(row.value, 0, 10) }))
      .sort((a, b) => a.n.localeCompare(b.n));
  }

  const hostRole = deriveAccelerators(r);

  model.listFailed = r.used === null;
  model.stateFailed = r.state === null;
  if (r.state !== null) {
    const tok = Object.fromEntries((r.tok || []).map((x) => [x.labels.model, x.value]));
    const perf = perfReader(r);
    // A model can have several serving-URL rows, so the URLs are grouped under their model name.
    const apiBase = new Map();
    for (const x of r.apiBase || []) {
      const n = x.labels.litellm_model_name;
      apiBase.set(n, [...(apiBase.get(n) ?? []), x.labels.api_base]);
    }
    // Only models with a real request in the last 4d, busiest first.
    model.models = assignModelColors(listedModels(r.state, r.used, r.requests).slice(0, 8).map((x) => {
      const n = x.labels.litellm_model_name;
      // Attached to the first device, in anchor order, that one of its serving URLs names. A model
      // whose URLs name no device (hosted rungs, an empty URL) belongs to the cloud node.
      let anchor = CLOUD;
      for (const url of apiBase.get(n) ?? []) {
        const role = hostRole.get(hostOf(url));
        if (role != null) anchor = Math.min(anchor, ROLE.get(role));
      }
      return { n, up: x.value < 2, tok: tok[n] ?? 0, perf: perf(n), anchor };
    }), PALETTE);
  }
  for (const m of model.models) accel[m.anchor].models += 1;

  model.tokensToday = billingClassValues(r.tokensToday);
  model.reqPerMin = billingClassValues(r.reqPerMin);
  model.modelCounts = modelCounts(model.models, r.localModels);
  model.gpuFailed = r.gpu === null;
  const busy = (r.gpu || []).map((x) => x.value).filter(Number.isFinite);
  model.gpuBusy = busy.length ? clamp(busy.reduce((x, y) => x + y, 0) / busy.length, 0, 100) : null;
  render();
}

// Rebuilds accel from the device, busy and request queries. Returns the host -> device-role map
// that models and request counts are matched through.
function deriveAccelerators(r) {
  const hostRole = new Map();
  const names = ANCHOR_DEFS.slice(0, CLOUD).map(() => new Set());
  for (const row of r.gpuModel || []) {
    // A series with no accelerator label is gpu-primary, matching accelerator:busy_percent:avg5m.
    const role = row.labels.accelerator || 'gpu-primary';
    if (!ROLE.has(role)) continue;
    const host = hostOf(row.labels.instance);
    if (host) hostRole.set(host, role);
    const name = shortDevice(row.labels.modelName);
    if (name) names[ROLE.get(role)].add(name);
  }
  for (const row of r.macChip || []) {
    const role = row.labels.accelerator;
    if (!ROLE.has(role)) continue;
    const host = hostOf(row.labels.instance);
    if (host) hostRole.set(host, role);
    const name = shortDevice(row.labels.chip);
    if (name) names[ROLE.get(role)].add(name);
  }

  const busy = ANCHOR_DEFS.map(() => null);
  for (const row of r.gpu || []) {
    if (ROLE.has(row.labels.accelerator) && Number.isFinite(row.value)) busy[ROLE.get(row.labels.accelerator)] = clamp(row.value, 0, 100);
  }

  // Requests: local engine readings map to a device only when its instance is known.
  const localRows = [r.vllm, r.llama];
  const hasLocalReadings = localRows.every((rows) => Array.isArray(rows) && rows.length > 0
    && rows.every((row) => Number.isFinite(row.value)));
  const localActive = hasLocalReadings ? localRows.flat().reduce((sum, row) => sum + row.value, 0) : null;
  const active = ANCHOR_DEFS.map(() => hasLocalReadings ? 0 : null);
  for (const row of localRows.flatMap((rows) => rows || [])) {
    const role = Number.isFinite(row.value) ? hostRole.get(hostOf(row.labels.instance)) : undefined;
    if (role == null) continue;
    active[ROLE.get(role)] += row.value;
  }
  // Cloud is the router count minus every local engine count, clamped at zero. Without both readings,
  // the cloud share is unknown.
  const inflight = r.inflight?.[0]?.value;
  const activeCloud = localActive != null && Number.isFinite(inflight) ? Math.max(0, Math.round(inflight - localActive)) : null;
  active[CLOUD] = activeCloud;
  model.active = { local: localActive, cloud: activeCloud };

  const plain = ANCHOR_DEFS.map((d, i) => {
    const o = overrides[d.id];
    if (typeof o === 'string' && o.trim()) return o.trim();
    return i < CLOUD ? ([...names[i]].sort().join(' + ') || d.id) : d.id;
  });
  // Two anchors that would read the same get their role tag, so each one stays distinguishable.
  const copies = new Map();
  for (const n of plain) copies.set(n, (copies.get(n) ?? 0) + 1);
  accel = ANCHOR_DEFS.map((d, i) => ({
    ...d,
    name: d.kind !== 'cloud' && copies.get(plain[i]) > 1 ? `${plain[i]} · ${d.id.split('-')[1].toUpperCase()}` : plain[i],
    busy: busy[i], active: active[i], models: 0,
  }));
  return hostRole;
}

/* ---------------- header ---------------- */
// The anchors as the 3D scene takes them: the busy and request readings, and whether the node is dim.
const sceneAnchors = () => accel.map((d) => ({ id: d.id, kind: d.kind, busy: d.busy, active: d.active, dim: isDim(d) }));

function render() {
  renderApps();
  renderCore();
  renderKpis();
  renderAnchors();
  reactor.dataset.modelColors = JSON.stringify(reactorList.map(({ n, color }) => ({ n, color })));
  core3d?.sync(model.models, model.tokensToday.local, sceneAnchors());
  markPending(); // the inputs changed: the next drawn frame takes them in and marks the signal ready
}

function renderKpis() {
  const k = [
    ['tokens today', classPair(model.tokensToday.local, model.tokensToday.cloud, (value) => `${(value / 1e6).toFixed(2)}M`)],
    ['requests/min', classPair(model.reqPerMin.local, model.reqPerMin.cloud, (value) => value.toFixed(0))],
    ['active · cloud = router − local', classPair(model.active.local, model.active.cloud, (value) => String(Math.round(value)))],
    ['models up', modelCountPair(model.modelCounts, true)],
  ];
  $('kpis').innerHTML = k.map(([label, value]) => `<div class="kpi"><b class="num split">${value}</b><span>${label}</span></div>`).join('');
  const serviceCount = aiApps.length || '—';
  $('subtitle').textContent = `${serviceCount} SERVICES · ${modelCountPair(model.modelCounts)}`;
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
  c.fillText(score == null ? '—' : Math.round(score), cx, cy - H * 0.03);
  c.fillStyle = '#8a5d90'; c.font = `${W * 0.055}px "JetBrains Mono",monospace`; c.fillText('HEALTH', cx, cy + H * 0.14);
}

// Only the AI-category services (Q.aiAppScore); a catalog service outside that category never shows here.
function renderApps() {
  const scores = aiApps.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = scores.length
    ? `<span style="color:var(--green)">${ok} OK</span> &middot; <span style="color:var(--amber)">${warn} DEG</span> &middot; <span style="color:var(--red)">${bad} DOWN</span>`
    : '—';
  $('applist').innerHTML = aiApps.map((a) => `<div class="ar"><i style="background:${hue(scorePct(a.s))}"></i><span>${esc(a.n)}</span><b class="num">${Math.round(a.s)}</b></div>`).join('');
  drawRing($('fleetRing'), scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null);
  const state = appScoreFailed ? (scores.length ? 'stale' : 'error') : (scores.length ? 'ok' : 'empty');
  const message = appScoreFailed
    ? (scores.length ? 'SCORE QUERY FAILED · SHOWING LAST GOOD' : 'SCORE QUERY FAILED')
    : (scores.length ? '' : 'NO SERVICE DATA');
  setState($('apps'), state, message);
}

/* ---------------- AI core (models table + reactor) ---------------- */
// The reactor list contains only current or last-good model rows; an empty list draws no model cores or streams.
let reactorList = [];
// Each card's large number is a per-request reading (site/lib/modelPerf.js perfCard): the engine's
// p50 decode speed, else the router's p50 request time. A model with no real request in the hour
// reads Idle, a real absence rather than a failed query.
// Rolling per-model history of that large number for the sparklines (model cards + fleet-health
// column). An idle poll appends a gap (null), never a zero. A new name starts from its first real
// reading, and a model whose large number changes unit starts over, so a line never mixes units.
const HIST_N = 24;
const perfHistory = new Map();
function pushHist(name, { spark, unit }) {
  let h = perfHistory.get(name);
  if (!h || (spark != null && h.unit != null && h.unit !== unit)) {
    h = { unit: null, values: Array(HIST_N).fill(spark) };
    perfHistory.set(name, h);
  } else {
    h.values.push(spark); h.values.shift();
  }
  if (spark != null) h.unit = unit;
}
function drawSpark(canvas, hist, color) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  // A faint dotted guide under every line, so an all-idle history still draws its frame.
  c.setLineDash([2 * dpr, 3 * dpr]);
  c.beginPath(); c.moveTo(0, h - dpr); c.lineTo(w, h - dpr);
  c.strokeStyle = `${color}40`; c.lineWidth = dpr; c.stroke();
  c.setLineDash([]);
  const max = Math.max(0, ...hist.filter(Number.isFinite)) || 1;
  c.beginPath();
  let pen = false; // a gap lifts the pen, so idle polls draw nothing
  hist.forEach((v, i) => {
    if (!Number.isFinite(v)) { pen = false; return; }
    const x = (i / (hist.length - 1)) * w, y = h - (v / max) * (h - 2 * dpr) - dpr;
    pen ? c.lineTo(x, y) : c.moveTo(x, y);
    pen = true;
  });
  c.strokeStyle = color; c.lineWidth = 1.5 * dpr; c.lineJoin = 'round'; c.stroke();
}

// Active: a real (non-health-check) request in the last hour, the same rule as the card's Idle text.
const active = (m) => !m.perf?.idle;

function renderCore() {
  const list = model.models;
  reactorList = list;
  const now = Date.now() / 1000;
  const cards = new Map(list.map((m) => [m.n, perfCard(m.perf, now)]));
  list.forEach((m) => pushHist(m.n, cards.get(m.n)));
  const tab = $('modeltab');
  // One row, always: an explicit column count (not auto-fit's width-based wrap) so N models
  // never orphan a lone tile onto a second row. Compact type kicks in once the row is dense
  // enough that auto-fit's old 200px-min columns would have wrapped anyway.
  tab.style.gridTemplateColumns = `repeat(${Math.max(list.length, 1)},minmax(0,1fr))`;
  tab.classList.toggle('dense', list.length > 5);
  // Bar: each model's share of real requests in the last hour, against the busiest listed model.
  const maxReq = Math.max(1, ...list.map((m) => m.perf?.requests ?? 0));
  tab.innerHTML = list.map((m) => {
    const col = m.up ? (active(m) ? 'var(--green)' : 'var(--cyan)') : 'var(--red)';
    const card = cards.get(m.n);
    const stats = m.up ? card.stats : ['health check failing', ...card.stats];
    const device = accel[m.anchor].name;
    return `<div class="mc" data-model="${esc(m.n)}" data-color="${m.color}" style="--mc-color:${m.color}"><div class="mch"><div class="mcname"><i class="mcswatch" aria-hidden="true"></i><b title="${esc(m.n)}">${esc(m.n.split('/').pop())}</b></div><span style="color:${col}">${m.up ? 'UP' : 'DOWN'}</span></div>
      <div class="mcat" title="${esc(device)}">${esc(device)}</div>
      <div class="mctok" style="color:${col}">${esc(card.value)}${card.unit ? `<i>${esc(card.unit)}</i>` : ''}</div>
      <canvas class="mcspark" data-model="${esc(m.n)}"></canvas>
      <div class="mcbar"><div style="width:${m.up ? clamp(100 * (m.perf?.requests ?? 0) / maxReq, 6, 100) : 100}%;background:${col}"></div></div>
      <div class="mcstats">${stats.map((s) => `<span>${esc(s)}</span>`).join('')}</div></div>`;
  }).join('');
  for (const canvas of $('modeltab').querySelectorAll('.mcspark')) {
    const m = list.find((x) => x.n === canvas.dataset.model);
    drawSpark(canvas, perfHistory.get(m.n).values, m.up ? (active(m) ? '#38ff9c' : '#3ee6ff') : '#ff3b5c');
  }
  $('coresum').textContent = modelCountPair(model.modelCounts, true);
  let state = 'ok', message = '';
  if (model.stateFailed) {
    state = list.length ? 'stale' : 'error';
    message = list.length ? 'MODEL QUERY FAILED · SHOWING LAST GOOD' : 'MODEL QUERY FAILED';
  } else if (model.listFailed) {
    state = 'error';
    message = 'MODEL USAGE QUERY FAILED';
  } else if (!list.length) {
    state = 'empty';
    message = 'NO RECENT MODEL DATA';
  }
  setState($('cores'), state, message);
  renderCoreExtra(list);
}

/* ---------------- fleet-health column fill: req/min, GPU/VRAM, sparklines, request feed ------- */
// GPU/VRAM is the mean of the accelerator busy series (Q.acceleratorBusy); an empty or failed
// query shows no percentage and includes its state beside the value. cxReqMin mirrors the header KPI.
function renderCoreExtra(list) {
  $('cxReqMin').textContent = classPair(model.reqPerMin.local, model.reqPerMin.cloud, (value) => value.toFixed(0));

  const gpuPct = model.gpuBusy;
  $('cxGpu').textContent = gpuPct == null ? '—' : `${Math.round(gpuPct)}%`;
  $('cxGpu').dataset.feed = gpuPct == null ? (model.gpuFailed ? 'error' : 'empty') : 'live';
  $('cxGpuMessage').textContent = gpuPct == null ? (model.gpuFailed ? 'QUERY FAILED' : 'NO DATA') : '';
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
    drawSpark(canvas, perfHistory.get(m.n).values, m.up ? '#3ee6ff' : '#ff3b5c');
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
    const res = await fetch('/api/llm/recent', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
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
const guardedPollFeed = guardRefresh(pollFeed);

/* ---------------- accelerator anchors: DOM labels over the hero canvas ---------------- */
// One label per anchor, always present. Its text comes from accel (the same readings the scene
// draws); its position comes each frame from the renderer's own projection (placeAnchors).
function renderAnchors() {
  const host = $('anchors');
  if (host.children.length !== accel.length) {
    host.innerHTML = accel.map((d) => `<div class="anchor kind-${d.kind}" data-accel="${d.id}"><div class="alab"></div></div>`).join('');
  }
  accel.forEach((d, i) => {
    const el = host.children[i];
    el.dataset.active = d.active == null ? '' : String(d.active);
    el.dataset.beads = d.active == null ? '' : String(Math.min(d.active, BEAD_CAP));
    el.dataset.models = String(d.models);
    el.dataset.busy = d.busy == null ? '' : String(Math.round(d.busy));
    el.classList.toggle('dim', isDim(d));
    const models = `${d.models} model${d.models === 1 ? '' : 's'}`;
    let busyLine, statusLine;
    if (d.kind === 'cloud') {
      busyLine = d.active == null ? 'no data' : d.active ? `${d.active} in flight · router − local` : 'idle';
      statusLine = d.models ? models : d.active == null ? 'no data' : 'no models';
    } else {
      busyLine = d.busy == null ? 'no data' : `${Math.round(d.busy)}% busy`;
      statusLine = d.models || d.active > 0
        ? [d.models ? models : null, d.active > 0 ? `${d.active} active` : null].filter(Boolean).join(' · ')
        : d.active == null ? 'no data' : 'idle';
    }
    const badge = d.active != null && d.active > BEAD_RING ? `<em class="badge">×${d.active}</em>` : '';
    el.querySelector('.alab').innerHTML = `<b class="an">${esc(d.name)}</b><span class="ab">${busyLine}</span><span class="as">${statusLine}</span>${badge}`;
  });
  layoutAnchors();
}

// The free area for the anchors, in CSS px: right of the fleet panel, under the header, above the model
// tile strip. The ellipse keeps every node's label box inside that area, so nothing clips at an edge.
// Both render paths read the same points (slots), and the 3D scene pins its nodes to them.
function layoutAnchors() {
  const fleet = $('apps').getBoundingClientRect();
  const head = document.querySelector('header').getBoundingClientRect();
  const strip = $('modeltab').getBoundingClientRect();
  const x0 = fleet.right + EDGE, x1 = innerWidth - EDGE;
  const y0 = head.bottom + EDGE, y1 = (strip.height ? strip.top : innerHeight) - EDGE;
  const minX = x0 + LABEL_W / 2, maxX = x1 - LABEL_W / 2;
  const minY = y0 + LABEL_TOP, maxY = y1 - LABEL_TOP - LABEL_H;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
  slots = ANCHOR_DEFS.map((d) => {
    const a = (d.angle * Math.PI) / 180;
    return { x: clamp(cx + rx * Math.cos(a), minX, maxX), y: clamp(cy + ry * Math.sin(a), minY, maxY) };
  });
  core3d?.layout(slots);
  // Labels move now, not on the next render frame: a 3D frame can take seconds, and a label left on
  // an earlier layout would sit on the tile strip until then.
  placeAnchors();
  markPending(); // the layout is a scene input: the next drawn frame takes the new slots in
}
function placeAnchors() {
  const host = $('anchors');
  for (let i = 0; i < accel.length; i++) {
    host.children[i].style.transform = `translate3d(${slots[i].x.toFixed(1)}px,${slots[i].y.toFixed(1)}px,0)`;
  }
}

/* ---------------- reactor: WebGPU/TSL hero (core3d.js) or 2D fallback ---------------- */
let reactor = $('reactor');
function fitCanvas(cv) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}

// Bead count per anchor as the 2D fallback eases it (the 3D scene keeps its own copy).
const beadShown = ANCHOR_DEFS.map(() => 0);
let lastDraw = 0;
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
  const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.1) : 0;
  lastDraw = now;
  const at = (i) => ({ x: slots[i].x * dpr, y: slots[i].y * dpr });

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
  c.fillText(list.length ? `${Math.round(upFrac * 100)}%` : '—', cx, cy);

  // Models orbit the anchor they are attached to. streams counts the models whose stream is drawn.
  let streams = 0;
  const perAnchor = ANCHOR_DEFS.map(() => 0);
  for (const m of list) perAnchor[m.anchor] += 1;
  const seenAt = ANCHOR_DEFS.map(() => 0);
  for (const m of list) {
    const k = seenAt[m.anchor]++, n = perAnchor[m.anchor];
    const p = at(m.anchor);
    const a = (k / n) * Math.PI * 2 + t * 0.25;
    const x = p.x + Math.cos(a) * R * 0.42, y = p.y + Math.sin(a) * R * 0.21;
    c.beginPath(); c.arc(x, y, (m.up ? 4 : 3) * dpr, 0, Math.PI * 2);
    c.fillStyle = m.color;
    c.shadowColor = m.up ? m.color : '#ff3b5c'; c.shadowBlur = 8 * dpr;
    if (!m.up) c.globalAlpha = 0.35;
    c.fill();
    if (!m.up) {
      c.globalAlpha = 1; c.strokeStyle = '#ff3b5c'; c.lineWidth = 1.5 * dpr; c.stroke();
    }
    c.shadowBlur = 0; c.globalAlpha = 1;
    // An up model with tokens in flight streams from its dot into the hub: travelling sparks, the 2D
    // fallback for the 3D stream. The same gate as the 3D stream.
    if (m.up && m.tok > 0.05) {
      streams += 1;
      for (let s = 0; s < 3; s++) {
        const f = (t * 0.3 + s / 3 + k * 0.21) % 1;
        c.beginPath(); c.arc(x + (cx - x) * f, y + (cy - y) * f, 1.6 * dpr, 0, Math.PI * 2);
        c.globalAlpha = Math.sin(f * Math.PI) * 0.9;
        c.fillStyle = m.color; c.fill();
      }
      c.globalAlpha = 1;
    }
  }
  // Read by the render-path checks: the count of streams drawn this frame (3D records the same on its canvas).
  reactor.dataset.streams = String(streams);

  // Anchor nodes (labelled by the DOM layer): a compact glow, an outline core sized by busy %, a
  // hairline halo and the busy arc, then the request beads. Nothing fills the node, so the particles
  // behind it stay visible; an idle or no-data node is an outline only.
  const dimmedIds = []; // the anchors drawn dim this frame, read by the render-path checks
  accel.forEach((d, i) => {
    const p = at(i), color = ANCHOR_COLOR[d.kind], dimmed = isDim(d);
    if (dimmed) dimmedIds.push(d.id);
    const lit = d.busy == null ? 0 : clamp(d.busy / 100, 0, 1);
    // Core radius 20-35 CSS px (a 40-70 px node at 1920x1080), scaled with the viewport height.
    const r0 = (20 + 15 * lit) * (Math.min(reactor.clientWidth, reactor.clientHeight) / 1080) * dpr;
    if (!dimmed) {
      const halo = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r0 * 2.2);
      halo.addColorStop(0, `${color}40`); halo.addColorStop(1, `${color}00`);
      c.fillStyle = halo; c.beginPath(); c.arc(p.x, p.y, r0 * 2.2, 0, Math.PI * 2); c.fill();
    }
    c.beginPath(); c.arc(p.x, p.y, r0 * 1.9, 0, Math.PI * 2);
    c.strokeStyle = `${color}${dimmed ? '1a' : '38'}`; c.lineWidth = dpr; c.stroke();
    c.beginPath();
    if (d.kind === 'cloud') {
      c.moveTo(p.x, p.y - r0); c.lineTo(p.x + r0, p.y); c.lineTo(p.x, p.y + r0); c.lineTo(p.x - r0, p.y); c.closePath();
    } else {
      c.arc(p.x, p.y, r0, 0, Math.PI * 2);
    }
    c.strokeStyle = dimmed ? `${color}80` : color; c.lineWidth = (dimmed ? 1.5 : 2.5) * dpr; c.stroke();
    if (d.busy != null) {
      c.beginPath(); c.arc(p.x, p.y, r0 + 6 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * lit);
      c.strokeStyle = color; c.lineWidth = 3 * dpr; c.stroke();
    }

    const target = Math.min(d.active, BEAD_CAP);
    beadShown[i] += (target - beadShown[i]) * (1 - Math.exp(-dt * 3));
    const n = Math.min(BEAD_CAP, Math.max(target, Math.ceil(beadShown[i] - 1e-3)));
    const rings = n > BEAD_RING ? Math.ceil(n / BEAD_RING) : 1;
    for (let k = 0; k < n; k++) {
      const fade = clamp(beadShown[i] - k, 0, 1);
      if (fade <= 0) continue;
      const ring = k % rings, j = Math.floor(k / rings), inRing = Math.ceil((n - ring) / rings);
      const phi = (j / inRing) * Math.PI * 2 + ring * 0.9 + (ring % 2 ? -1 : 1) * t * (0.9 / (1 + ring * 0.35));
      const rr = R * (0.2 + ring * 0.05);
      const x = p.x + Math.cos(phi) * rr, y = p.y + Math.sin(phi) * rr * 0.4;
      c.beginPath(); c.arc(x, y, (rings > 1 ? 2.2 : 3.2) * dpr * fade, 0, Math.PI * 2);
      c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 10 * dpr; c.fill(); c.shadowBlur = 0;
    }
  });
  reactor.dataset.dimAnchors = dimmedIds.join(',');
}

/* ---------------- boot ---------------- */
const forced = new URLSearchParams(location.search).get('gl');
let core3d = null;
// The readiness signal (data-scene) and the mode (data-renderer). markPending() runs on every change to the
// scene's inputs; the frame that draws them calls markDrawn(), which turns 'pending' into 'ready'. A frame
// runs to completion, so 'ready' means the latest inputs are on the canvas and in the labels.
function markPending() { reactor.dataset.scene = 'pending'; }
function markDrawn() { if (reactor.dataset.scene === 'pending') reactor.dataset.scene = 'ready'; }
function draw2D(now) { drawReactor(now); markDrawn(); }
let drawScene = draw2D;
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
  reactor.dataset.renderer = '2d';
  markPending();
  drawScene = draw2D;
}
async function startGpuCore() {
  gpuAttempts += 1;
  drawScene = () => {};
  reactor.dataset.renderer = '3d';
  markPending();
  try {
    const { buildGpuCore } = await import('/mc3/core3d.js');
    const core = await buildGpuCore(reactor, {
      palette: PALETTE,
      reducedMotion: RM,
      pointer,
      onLost: () => {
        core.dispose();
        if (core3d === core) core3d = null;
        freshReactor();
        if (gpuAttempts < 3) startGpuCore(); else use2D('GPU device lost repeatedly');
      },
    });
    if (core3d && core3d !== core) core3d.dispose();
    core3d = core;
    core.layout(slots);
  core.sync(model.models.length ? model.models : reactorList, model.tokensToday.local, sceneAnchors());
    markPending();
    drawScene = (now) => {
      core.render(now);
      markDrawn();
    };
  } catch (e) {
    use2D(e);
  }
}
if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  startGpuCore();
  onDispose(() => core3d?.dispose());
} else {
  reactor.dataset.renderer = '2d';
  markPending();
}

const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
// The render loop (and the 'ready' postMessage it fires — site/lib/stage.js) starts before the
// first data refresh resolves. Gating it behind `await refresh()` is what let a slow/failing
// litellm query on this very page delay 'ready' past the rotator's probe window and get MC3
// skipped as broken on the live wall.
renderAnchors();
addEventListener('resize', layoutAnchors);
onDispose(() => removeEventListener('resize', layoutAnchors));
// The label layout also follows the header, fleet panel and tile strip: a font load or a change in the
// model count can resize them after the last layout, and the labels must not sit on the strip.
const layoutObserver = new ResizeObserver(layoutAnchors);
for (const el of [document.querySelector('header'), $('apps'), $('modeltab')]) layoutObserver.observe(el);
onDispose(() => layoutObserver.disconnect());
loop(0, (now) => { drawScene(now); placeAnchors(); }); // uncapped: native refresh rate, the display has headroom to spare
// The first feed poll runs alongside the first refresh, never after it: a slow refresh must not
// hold the request feed on its empty placeholder (pollFeed handles its own failures).
const guardedRefresh = guardRefresh(refresh);
await Promise.all([guardedRefresh().catch((e) => console.warn('refresh', e)), guardedPollFeed()]);
const feedId = setInterval(guardedPollFeed, FEED_POLL_MS);
onDispose(() => clearInterval(feedId));
const refreshId = setInterval(() => guardedRefresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
