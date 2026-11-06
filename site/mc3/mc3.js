import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import {
  clamp, esc, loop, loadConfig,
  onDispose, hardwareGL,
} from '/lib/stage.js';
import { loadBenchmarks, renderBenchmarks, renderCoreExtra } from './benchmarks.js';
import { drawReactor } from './reactor2d.js';
import { recentFeed, FEED_POLL_MS } from './recent.js';
import { ANCHOR_DEFS, accel, deriveAccelerators, hostOf, isDim } from './accelerators.js';
import { renderKpis, renderApps } from './fleet.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];

const cfg = await loadConfig();

/* ---------------- accelerator anchors: layout, naming, attachment ---------------- */
const LABEL_W = 320, LABEL_TOP = 40, LABEL_H = 84, EDGE = 16;
const BEAD_RING = 12, BEAD_CAP = 36;
let slots = ANCHOR_DEFS.map(() => ({ x: 0, y: 0 }));
const CLOUD = ANCHOR_DEFS.length - 1;
const ROLE = new Map(ANCHOR_DEFS.slice(0, CLOUD).map((d, i) => [d.id, i]));
const overrides = cfg.accelerators && typeof cfg.accelerators === 'object' ? cfg.accelerators : {};
const model = { models: [], tokensToday: null, reqPerMin: null, gpuBusy: null, inflight: null };
let aiApps = [];

let benchmarkData = {};

async function refresh() {
  const r = await settle({
    benchmarks: loadBenchmarks,
    score: () => query(Q.aiAppScore),
    state: () => query(Q.llmState),
    tok: () => query(Q.llmTokRate),
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

  benchmarkData = r.benchmarks || {};
  aiApps = [];
  if (r.score) {
    aiApps = r.score
      .filter((row) => row.labels.name && Number.isFinite(row.value))
      .map((row) => ({ n: row.labels.name, s: clamp(row.value, 0, 10) }))
      .sort((a, b) => a.n.localeCompare(b.n));
  }

  const hostRole = deriveAccelerators(r, overrides);
  model.inflight = Number.isFinite(r.inflight?.[0]?.value) ? r.inflight[0].value : null;

  model.models = [];
  if (r.state) {
    const tok = Object.fromEntries((r.tok || []).map((x) => [x.labels.model, x.value]));
    const apiBase = new Map();
    for (const x of r.apiBase || []) {
      const n = x.labels.litellm_model_name;
      apiBase.set(n, [...(apiBase.get(n) ?? []), x.labels.api_base]);
    }
    model.models = r.state.filter((x) => x.labels.litellm_model_name && Number.isFinite(x.value)).map((x) => {
      const n = x.labels.litellm_model_name;
      let anchor = CLOUD;
      for (const url of apiBase.get(n) ?? []) {
        const role = hostRole.get(hostOf(url));
        if (role != null) anchor = Math.min(anchor, ROLE.get(role));
      }
      return {
        n, up: x.value < 2, tok: Number.isFinite(tok[n]) ? tok[n] : null,
        anchor,
      };
    }).sort((a, b) => (b.up - a.up) || b.tok - a.tok || a.n.localeCompare(b.n));
  }
  for (const m of model.models) accel[m.anchor].models += 1;

  model.tokensToday = Number.isFinite(r.tokensToday?.[0]?.value) ? r.tokensToday[0].value : null;
  model.reqPerMin = Number.isFinite(r.reqPerMin?.[0]?.value) ? r.reqPerMin[0].value : null;
  const busy = (r.gpu || []).map((x) => x.value).filter(Number.isFinite);
  model.gpuBusy = busy.length ? clamp(busy.reduce((x, y) => x + y, 0) / busy.length, 0, 100) : null;
  render();
}

/* ---------------- header ---------------- */
const sceneAnchors = () => accel.map((d) => ({ id: d.id, kind: d.kind, busy: d.busy, active: d.active, dim: isDim(d) }));

function render() {
  renderApps(aiApps);
  renderBenchmarks(model.models, benchmarkData, accel);
  renderCoreExtra(model, benchmarkData);
  renderKpis(model, aiApps);
  renderAnchors();
  core3d?.sync(model.models, model.tokensToday, sceneAnchors());
  markPending(); // the inputs changed: the next drawn frame takes them in and marks the signal ready
}

/* ---------------- accelerator anchors: DOM labels over the hero canvas ---------------- */
function renderAnchors() {
  const host = $('anchors');
  if (host.children.length !== accel.length) {
    host.innerHTML = accel.map((d) => `<div class="anchor kind-${d.kind}" data-accel="${d.id}"><div class="alab"></div></div>`).join('');
  }
  accel.forEach((d, i) => {
    const el = host.children[i];
    el.dataset.active = String(d.active);
    el.dataset.beads = String(Math.min(d.active, BEAD_CAP));
    el.dataset.models = String(d.models);
    el.dataset.busy = d.busy == null ? '' : String(Math.round(d.busy));
    el.classList.toggle('dim', isDim(d));
    const models = `${d.models} model${d.models === 1 ? '' : 's'}`;
    let busyLine, statusLine;
    if (d.kind === 'cloud') {
      busyLine = d.active ? `${d.active} in flight` : 'idle';
      statusLine = d.models ? models : 'no models';
    } else {
      busyLine = d.busy == null ? 'no data' : `${Math.round(d.busy)}% busy`;
      statusLine = d.models || d.active
        ? [d.models ? models : null, d.active ? `${d.active} active` : null].filter(Boolean).join(' · ')
        : 'idle';
    }
    const badge = d.active > BEAD_RING ? `<em class="badge">×${d.active}</em>` : '';
    el.querySelector('.alab').innerHTML = `<b class="an">${esc(d.name)}</b><span class="ab">${busyLine}</span><span class="as">${statusLine}</span>${badge}`;
  });
  layoutAnchors();
}

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
/* ---------------- boot ---------------- */
const forced = new URLSearchParams(location.search).get('gl');
let core3d = null;
const pollFeed = recentFeed(() => core3d);
function markPending() { reactor.dataset.scene = 'pending'; }
function markDrawn() { if (reactor.dataset.scene === 'pending') reactor.dataset.scene = 'ready'; }
function draw2D(now) { drawReactor(reactor, now, { list: model.models, accel, slots, isDim }); markDrawn(); }
let drawScene = draw2D;
let gpuAttempts = 0;
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
    core.sync(model.models, model.tokensToday, sceneAnchors());
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
renderAnchors();
addEventListener('resize', layoutAnchors);
onDispose(() => removeEventListener('resize', layoutAnchors));
const layoutObserver = new ResizeObserver(layoutAnchors);
for (const el of [document.querySelector('header'), $('apps'), $('modeltab')]) layoutObserver.observe(el);
onDispose(() => layoutObserver.disconnect());
loop(0, (now) => { drawScene(now); placeAnchors(); }); // uncapped: native refresh rate, the display has headroom to spare
await Promise.all([refresh().catch((e) => console.warn('refresh', e)), pollFeed()]);
const feedId = setInterval(pollFeed, FEED_POLL_MS);
onDispose(() => clearInterval(feedId));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
setTimeout(() => location.reload(), 24 * 3600 * 1000);
