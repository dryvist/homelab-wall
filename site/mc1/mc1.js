// Mission Control 1: estate overview, driven by live Prometheus data.
import { query, range, settle, shortHost } from '/lib/prom.js';
import { guardRefresh } from '/lib/refresh.js';
import { Q } from '/lib/queries.js';
import { listedModels } from '/lib/modelPerf.js';
import {
  clamp, hue, lerp, esc, observeCanvas, loop, loadConfig, setState,
  SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct,
  onDispose,
} from '/lib/stage.js';
import { lastGoodGet, lastGoodSet } from '/lib/lastGood.js';
import { groupedHexLayout } from '/lib/hexlayout.js';
import { buildStorageRows, formatMbps, formatStorageBytes, gpuByNode } from '/lib/mc1Metrics.js';
import { buildFirewallRows, buildTopologyModel, namedFlowRows } from '/lib/mc1Topology.js';
import { createTopologyView } from './topologyView.js';
import { splitByClass } from '/lib/mc3.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];
const STALE_MS = 5 * 60 * 1000;

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = (cfg.groups || []).map((g, i) => ({ ...g, c: PALETTE[i % PALETTE.length] }));
// Grouped by config.groups order (first group wins for a duplicate), never alphabetical —
// hexLayout keeps the null gap markers the hex grid draws as empty cells between groups.
const hexLayout = groupedHexLayout(groups);
const apps = hexLayout.filter((n) => n !== null).map((n) => ({ n, s: null, d: 0 }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
// Grid-drawing order only (drawHex): same order as `apps`, with `null` gap cells re-inserted —
// scoring/summary code below always uses `apps`/`appIndex`, never this.
const hexCells = hexLayout.map((n) => (n === null ? null : appIndex[n]));
const model = { nodes: [], storage: [], llm: [], llmAll: [], wan: [], wanPorts: [], uptime: null, updated: 0 };
setState($('fw'), 'no-feed');
setState($('vlans'), 'pending', 'VLAN METRICS PENDING');
setState($('wan'), 'pending', 'WAN METRICS PENDING');
// D-mc1-2: the node card list must be driven by which nodes are CONFIGURED, never by which
// series a single poll happened to return — a node that drops out of Prometheus for one poll
// (a scrape gap, a restart) must keep its card, not vanish from it.
const nodeOrder = Object.keys(cfg.nodeRoles || {}).sort((a, b) => b.localeCompare(a));

/* ---------------- data ---------------- */
function byHost(rows) {
  return Object.fromEntries((rows || []).map((r) => [shortHost(r.labels.instance), r.value]));
}

async function refresh() {
  const r = await settle({
    score: () => query(Q.appScore),
    uptime: () => query(Q.uptime24h),
    cpu: () => query(Q.nodeCpu),
    cores: () => query(Q.nodeCores),
    mem: () => query(Q.nodeMem),
    memTotal: () => query(Q.nodeMemTotal),
    load: () => query(Q.nodeLoad),
    temp: () => query(Q.nodeTemp),
    upt: () => query(Q.nodeUptime),
    gpuModel: () => query(Q.gpuModel),
    guestNode: () => query(Q.guestNode),
    gpu: () => query(Q.acceleratorBusy),
    hist: () => range(Q.nodeCpu, 30, 30),
    fsSize: () => query(Q.fsSize),
    fsAvail: () => query(Q.fsAvail),
    pveStorageUsed: () => query(Q.pveStorageUsed),
    wanRx: () => query(Q.wanRxBytes),
    wanTx: () => query(Q.wanTxBytes),
    vlanRx: () => query(Q.vlanRxBytes),
    vlanTx: () => query(Q.vlanTxBytes),
    deviceInfo: () => query(Q.deviceInfo),
    deviceRx: () => query(Q.deviceRxBytes),
    deviceTx: () => query(Q.deviceTxBytes),
    fwFlows: () => query(Q.fwFlowEvents),
    fwDrops: () => query(Q.fwWanDrops),
    fwRules: () => query(Q.fwRuleEvents),
    llmState: () => query(Q.llmState),
    llmUsed: () => query(Q.llmUsed4d),
    llmTok: () => query(Q.routerOutput),
    llmLocalModels: () => query(Q.llmLocalModels),
  });

  // settle() (lib/prom.js) yields null for a query that rejected (bad status, timeout, bad
  // body) — distinct from a query that succeeded with zero rows. A failed score query must
  // never keep old scores on screen; it renders as an explicit error instead.
  model.scoreFailed = r.score === null;
  if (r.score === null) {
    for (const a of apps) a.s = null;
  } else {
    const seen = new Set();
    for (const row of r.score) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 10); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
  model.uptimeFailed = r.uptime === null;
  const uptime = r.uptime?.[0]?.value;
  model.uptime = Number.isFinite(uptime) ? uptime : null;

  const [cores, mem, memT, load, temp, upt] = [r.cores, r.mem, r.memTotal, r.load, r.temp, r.upt].map(byHost);
  const cpu = byHost(r.cpu);
  const hist = Object.fromEntries((r.hist || []).map((h) => [shortHost(h.labels.instance), h.values]));
  const liveNow = new Set((r.cpu || []).map((row) => shortHost(row.labels.instance)));
  model.cpuFailed = r.cpu === null;
  model.nodeMetricsFailed = [r.cpu, r.cores, r.mem, r.memTotal, r.load].some((rows) => rows === null);
  model.gpuFailed = r.gpuModel === null || r.guestNode === null || r.gpu === null;
  const gpuNodes = model.gpuFailed ? new Map() : gpuByNode(r.gpuModel, r.guestNode, r.gpu);
  model.nodes = nodeOrder.map((name) => {
    const prev = model.nodes.find((n) => n.name === name) || {};
    const gpu = gpuNodes.get(name);
    const gpuValue = model.gpuFailed || !Number.isFinite(gpu?.value) ? null : clamp(gpu.value, 0, 100);
    const hasGpu = !model.gpuFailed && !!gpu?.hasAccelerator;
    // A role mapping that echoes the node's own name adds no information to its subtitle.
    const role = cfg.nodeRoles?.[name] === name ? '' : (cfg.nodeRoles?.[name] || '');
    if (liveNow.has(name)) {
      const fresh = {
        cpu: Number.isFinite(cpu[name]) ? cpu[name] : null,
        mem: Number.isFinite(mem[name]) ? mem[name] : null,
        load: Number.isFinite(load[name]) ? load[name] : null,
        cores: Number.isFinite(cores[name]) ? cores[name] : null,
        ram: Number.isFinite(memT[name]) ? memT[name] : null,
        temp: temp[name], up: upt[name], hist: hist[name] || [],
      };
      lastGoodSet(`node:${name}`, fresh);
      return { ...prev, name, role, ...fresh, gpu: gpuValue, hasGpu, stale: false, pending: false, lastSeen: Date.now(), d: prev.d || { cpu: 0, mem: 0, load: 0, gpu: null } };
    }
    // Keep the last real node reading and mark it stale while its series is absent.
    const last = lastGoodGet(`node:${name}`);
    const values = last?.value || {};
    const hasReading = ['cpu', 'mem', 'load', 'cores', 'ram'].some((key) => Number.isFinite(values[key]));
    return {
      ...prev, name, role, ...values,
      gpu: gpuValue, hasGpu,
      stale: hasReading, pending: !hasReading, lastSeen: last?.at ?? prev.lastSeen ?? null,
      d: prev.d || { cpu: 0, mem: 0, load: 0, gpu: null },
    };
  });
  for (const x of cfg.extraNodes || []) {
    if (!nodeOrder.includes(x.name) && !liveNow.has(x.name)) {
      const gpu = gpuNodes.get(x.name);
      model.nodes.push({ name: x.name, role: x.role, pending: true, gpu: model.gpuFailed || !Number.isFinite(gpu?.value) ? null : clamp(gpu.value, 0, 100),
        hasGpu: !model.gpuFailed && !!gpu?.hasAccelerator, d: { cpu: 0, mem: 0, load: 0, gpu: null } });
    }
  }

  model.storageFailed = r.fsSize === null || r.fsAvail === null;
  model.storageIncomplete = false;
  if (!model.storageFailed) {
    const storage = buildStorageRows(r.fsSize, r.fsAvail, r.pveStorageUsed, r.pveStorageUsed === null);
    model.storage = storage.rows;
    model.storageIncomplete = storage.incomplete;
  } else {
    model.storage = [];
  }

  model.wanRxFailed = r.wanRx === null;
  model.wanTxFailed = r.wanTx === null;
  const byPort = (rows) => new Map((rows || [])
    .filter((row) => row.labels.port != null && Number.isFinite(row.value))
    .map((row) => [row.labels.port, row.value]));
  const rx = byPort(r.wanRx), tx = byPort(r.wanTx);
  // Retain observed ports so a missing series cannot renumber the others.
  const ports = [...new Set([...model.wanPorts, ...rx.keys(), ...tx.keys()])]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  model.wanPorts = ports;
  model.wan = ports.map((port) => ({ port, down: rx.get(port) ?? null, up: tx.get(port) ?? null }));

  model.vlanRxFailed = r.vlanRx === null;
  model.vlanTxFailed = r.vlanTx === null;
  const flowRows = namedFlowRows(r.fwFlows || [], [...(r.vlanRx || []), ...(r.vlanTx || [])]);
  model.topology = buildTopologyModel({
    groups, vlanRxRows: r.vlanRx || [], vlanTxRows: r.vlanTx || [], deviceRows: r.deviceInfo || [],
    deviceRxRows: r.deviceRx || [], deviceTxRows: r.deviceTx || [], wanRxRows: r.wanRx || [], wanTxRows: r.wanTx || [],
    flowRows,
  });
  model.firewall = buildFirewallRows(r.fwDrops || [], flowRows, r.fwRules || []);
  model.firewallFailed = r.fwDrops === null || r.fwFlows === null || r.fwRules === null;
  model.firewallError = r.fwDrops === null ? 'WAN DROP QUERY FAILED'
    : r.fwFlows === null ? 'FIREWALL FLOW QUERY FAILED' : r.fwRules === null ? 'FIREWALL RULE QUERY FAILED' : '';

  // Only models with a real request in the last 4d (Q.llmUsed4d), in the existing order; the summary
  // line counts the same models. A failed Q.llmUsed4d lists every deployment and marks the panel.
  model.llmFailed = r.llmState === null || r.llmUsed === null;
  model.llmTokFailed = r.llmTok === null;
  model.llmClassFailed = r.llmLocalModels === null;
  model.llmLocalNames = new Set((r.llmLocalModels || []).map((row) => row.labels.model).filter((name) => typeof name === 'string'));
  const previousLlm = model.llmAll;
  model.llmAll = [];
  model.llm = [];
  if (r.llmState !== null) {
    const tok = Object.fromEntries((r.llmTok || []).filter((x) => Number.isFinite(x.value)).map((x) => [x.labels.model, x.value]));
    model.llmAll = listedModels(r.llmState, r.llmUsed, null).map((x) => {
      const n = x.labels.litellm_model_name;
      const prev = previousLlm.find((m) => m.n === n);
      const t = Number.isFinite(tok[n]) ? tok[n] : null;
      return { n, state: x.value, tok: t, hist: [...(prev?.hist || []), t].slice(-30) };
    }).sort((a, b) => b.state - a.state || (b.tok ?? -1) - (a.tok ?? -1) || a.n.localeCompare(b.n));
    model.llm = model.llmAll.slice(0, 9);
  }
  model.updated = Date.now();
  renderStatic();
}

/* ---------------- header ---------------- */
const TB = 1e12, GB = 1e9;
function renderHeader() {
  const configuredNodes = nodeOrder.map((name) => model.nodes.find((n) => n.name === name));
  const coresKnown = configuredNodes.length > 0 && configuredNodes.every((n) => Number.isFinite(n?.cores));
  const ramKnown = configuredNodes.length > 0 && configuredNodes.every((n) => Number.isFinite(n?.ram));
  const nodeDataStale = configuredNodes.some((n) => n?.stale);
  const cores = coresKnown ? configuredNodes.reduce((a, n) => a + n.cores, 0) : null;
  const ram = ramKnown ? configuredNodes.reduce((a, n) => a + n.ram, 0) : null;
  const raw = model.storage.length && model.storage.every((s) => Number.isFinite(s.size))
    ? model.storage.reduce((a, s) => a + s.size, 0) : null;
  const status = (value, failed = false) => value == null ? (failed ? 'QUERY FAILED' : 'NO DATA') : '';
  const rawStatus = model.storageFailed ? 'QUERY FAILED' : model.storageIncomplete ? 'INCOMPLETE' : raw == null ? 'NO DATA' : '';
  const k = [
    ['guests', cfg.guestCount, '', cfg.guestCount == null ? 'NO CONFIG' : ''],
    ['cores', cores, '', cores == null ? status(cores, model.nodeMetricsFailed) : nodeDataStale ? 'STALE' : ''],
    ['RAM', ram == null ? null : Math.round(ram / GB), 'GB', ram == null ? status(ram, model.nodeMetricsFailed) : nodeDataStale ? 'STALE' : ''],
    ['raw', raw == null ? null : (raw / TB).toFixed(1), 'TB', rawStatus],
    ['apps', apps.length, '', ''],
    ['uptime 24h', model.uptime == null ? null : model.uptime.toFixed(2), '%', status(model.uptime, model.uptimeFailed)],
  ];
  $('kpis').innerHTML = k.map(([l, v, u, message]) => `<div class="kpi"><b class="num">${v == null ? '—' : esc(v)}<i>${u}</i></b><span>${l}${message ? ` · ${message}` : ''}</span></div>`).join('');
  const scored = apps.filter((a) => a.s != null);
  // The fleet ring is the MINIMUM across every scored app, never an average — an average dilutes
  // a single DOWN app to nothing once enough other apps are healthy (it can round back up to 10,
  // the "100% uptime" value, while an app sits at 0). The fleet can never look healthier than its
  // worst known app; an empty score set leaves the ring without a number.
  const ringScore = scored.length ? Math.min(...scored.map((x) => x.s)) : null;
  ring($('estateRing'), ringScore);
  $('subtitle').textContent = `${model.nodes.filter((n) => !n.pending).length} NODES · ${groups.length} GROUPS · ${apps.length} APPS`;
}
function ring(el, score) {
  const c = el.getContext('2d'); c.clearRect(0, 0, 128, 128); c.lineWidth = 10;
  c.strokeStyle = '#0d2233'; c.beginPath(); c.arc(64, 64, 52, 0, 7); c.stroke();
  if (score != null) {
    c.strokeStyle = hue(scorePct(score)); c.shadowColor = hue(scorePct(score)); c.shadowBlur = 14;
    c.beginPath(); c.arc(64, 64, 52, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score / 10); c.stroke(); c.shadowBlur = 0;
  }
  c.fillStyle = '#fff'; c.font = '600 34px "Chakra Petch",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(score == null ? '—' : Math.round(score), 64, 60);
  c.fillStyle = '#5d7d90'; c.font = '14px "JetBrains Mono",monospace'; c.fillText('HEALTH', 64, 90);
}

/* ---------------- nodes ---------------- */
let nodeKey = '';
function buildNodes() {
  const key = model.nodes.map((n) => n.name).join();
  if (key === nodeKey) return;
  nodeKey = key;
  $('nodelist').innerHTML = model.nodes.map((n, i) => `<div class="node${n.pending ? ' mac' : ''}" id="node${i}"><div class="nm">${esc(n.name.toUpperCase())}<em id="nm${i}"></em></div>
    ${[0, 1, 2, 3].map((g) => `<canvas class="g" id="g${i}${g}" width="184" height="184"></canvas>`).join('')}
    <canvas class="sp" id="sp${i}" width="780" height="52"></canvas></div>`).join('');
}
function ageLabel(atMs) {
  const s = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}
function gauge(id, val, max, label, unit, col) {
  const el = $(id); if (!el) return;
  const c = el.getContext('2d'); c.clearRect(0, 0, 184, 184);
  const cx = 92, cy = 92, r = 66, a0 = Math.PI * 0.75, span = Math.PI * 1.5, f = val == null ? 0 : clamp(val / max, 0, 1);
  for (let i = 0; i <= 40; i++) {
    const a = a0 + span * i / 40, on = i / 40 <= f && val != null;
    c.strokeStyle = on ? col : '#10283a'; c.lineWidth = on ? 4 : 3;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10)); c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); c.stroke();
  }
  if (val != null) { c.shadowColor = col; c.shadowBlur = 12; c.strokeStyle = col; c.lineWidth = 3; c.beginPath(); c.arc(cx, cy, r + 6, a0, a0 + span * f); c.stroke(); c.shadowBlur = 0; }
  const sp = RM ? 0 : performance.now() / 1500;
  c.strokeStyle = 'rgba(62,230,255,.35)'; c.lineWidth = 1;
  for (let k = 0; k < 6; k++) { c.beginPath(); c.arc(cx, cy, r + 14, sp + k * 1.05, sp + k * 1.05 + 0.55); c.stroke(); }
  c.fillStyle = '#fff'; c.font = '600 34px "Chakra Petch",sans-serif'; c.textAlign = 'center';
  if (label !== 'NO GPU') c.fillText(val == null ? '—' : val.toFixed(unit === '%' ? 0 : 1), cx, cy + 6);
  c.fillStyle = '#5d7d90'; c.font = '15px "JetBrains Mono",monospace'; c.fillText(label + (unit === '%' ? ' %' : ''), cx, cy + 34);
}
// No history yet: a dim dashed baseline, never an invented trace.
function noHistory(c, w, h) {
  c.setLineDash([6, 6]); c.strokeStyle = '#1d3a4f'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, h - 2); c.lineTo(w, h - 2); c.stroke(); c.setLineDash([]);
}
function spark(id, h) {
  const el = $(id); if (!el) return;
  const c = el.getContext('2d'), W = 780, H = 52; c.clearRect(0, 0, W, H);
  if (h.length < 2) {
    noHistory(c, W, H);
    return;
  }
  const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(62,230,255,.35)'); g.addColorStop(1, 'rgba(62,230,255,0)');
  c.beginPath(); h.forEach((v, i) => { const x = i / (h.length - 1) * W, y = H - clamp(v, 0, 100) / 100 * H; i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = '#3ee6ff'; c.lineWidth = 2; c.stroke(); c.lineTo(W, H); c.lineTo(0, H); c.fillStyle = g; c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(W - 4, H - clamp(h[h.length - 1], 0, 100) / 100 * H, 4, 0, 7); c.fill();
}
function drawNodes() {
  model.nodes.forEach((n, i) => {
    for (const k of ['cpu', 'mem', 'load']) n.d[k] = n[k] == null ? null : lerp(n.d[k] ?? 0, n[k], 0.15);
    n.d.gpu = n.gpu == null ? null : lerp(n.d.gpu ?? n.gpu, n.gpu, 0.15);
    const d = n.d;
    const loadMax = n.cores > 0 ? n.cores : 1;
    gauge(`g${i}0`, d.cpu, 100, 'CPU', '%', hue(100 - (d.cpu ?? 0)));
    gauge(`g${i}1`, d.mem, 100, 'MEM', '%', hue(100 - (d.mem ?? 0)));
    gauge(`g${i}2`, d.load, loadMax, 'LOAD', '', hue(100 - (d.load ?? 0) / loadMax * 100));
    const gpuLabel = model.gpuFailed || n.hasGpu ? 'GPU' : 'NO GPU';
    gauge(`g${i}3`, n.d.gpu, 100, gpuLabel, gpuLabel === 'GPU' ? '%' : '', gpuLabel === 'GPU' ? hue(100 - (n.d.gpu ?? 0)) : '#5d7d90');
    spark(`sp${i}`, n.hist || []);
    const meta = n.pending ? `${n.role || 'NODE'} · METRICS PENDING`
      : n.stale
        ? (n.lastSeen == null ? 'STALE'
          : Date.now() - n.lastSeen < STALE_MS ? `STALE ${ageLabel(n.lastSeen)}`
          : `STALE since ${new Date(n.lastSeen).toTimeString().slice(0, 8)}`)
        : `${n.role ? n.role + ' · ' : ''}${n.temp != null ? Math.round(n.temp) + '°C · ' : ''}${n.up != null ? 'up ' + Math.floor(n.up / 86400) + 'd' : ''}`;
    const el = $('nm' + i); if (el && el.textContent !== meta) el.textContent = meta;
    const card = $('node' + i); if (card) card.classList.toggle('stale', !!n.stale);
  });
  renderQuorum();
}
function renderQuorum() {
  const up = model.nodes.filter((n) => !n.pending && !n.stale).length;
  $('quorum').textContent = `${model.cpuFailed ? '—' : up}/${model.nodes.length} UP`;
}

/* ---------------- storage ---------------- */
function renderStorage() {
  const rows = model.storage;
  const firstRow = $('strows').querySelector('.st');
  // Layout height: the panel's 3D sway transform inflates the bounding box.
  const rowHeight = firstRow?.offsetHeight || 18.5;
  const capacity = Math.max(1, Math.floor(($('storage').clientHeight - $('storage').querySelector('h2').offsetHeight - 6) / rowHeight));
  const visibleCount = rows.length > capacity ? Math.max(0, capacity - 1) : rows.length;
  const visible = rows.slice(0, visibleCount);
  $('strows').innerHTML = rows.length ? visible.map((s) => {
    const p = Number.isFinite(s.used) && Number.isFinite(s.size) && s.size > 0 ? s.used / s.size * 100 : null, col = hue(100 - (p ?? 0));
    return `<div class="st"><span>${esc(s.host)} <em>${esc(s.name)}</em></span><div class="bar"><div style="width:${p ?? 0}%;background:linear-gradient(90deg,${col.replace('hsl', 'hsla').replace(')', ',.2)')},${col});box-shadow:0 0 10px ${col}"></div></div><span class="v num"><b>${p == null ? '—' : `${p.toFixed(0)}%`}</b> ${formatStorageBytes(s.size)}</span></div>`;
  }).join('') + (rows.length > visible.length ? `<div class="st more">+${rows.length - visible.length} more</div>` : '') : '—';
  const total = rows.every((s) => Number.isFinite(s.size)) ? rows.reduce((a, s) => a + s.size, 0) : null;
  const used = rows.every((s) => Number.isFinite(s.used)) ? rows.reduce((a, s) => a + s.used, 0) : null;
  $('sttot').textContent = rows.length ? `${used == null ? '—' : (used / TB).toFixed(1)} / ${total == null ? '—' : (total / TB).toFixed(1)} TB` : '—';
}

/* ---------------- LLM panel ---------------- */
function renderLlm() {
  const list = model.llm;
  $('llmrows').innerHTML = list.length ? list.map((m, i) => {
    const up = m.state < 2, col = m.state === 0 ? (m.tok > 0 ? '#38ff9c' : '#3ee6ff') : m.state === 1 ? '#ffb347' : '#ff3b5c';
    return `<div class="lr"><i style="background:${col};box-shadow:0 0 8px ${col}"></i><span title="${esc(m.n)}">${esc(m.n.split('/').pop())}</span><canvas id="lc${i}" width="116" height="28"></canvas><span class="tk" style="color:${up ? '#fff' : '#ff3b5c'}">${!up ? 'DOWN' : m.tok == null ? '—' : m.tok > 0.05 ? m.tok.toFixed(0) + ' t/s' : 'idle'}</span><span class="h">${['ok', 'degraded', 'outage'][m.state] || '?'}</span></div>`;
  }).join('') : '—';
  list.forEach((m, i) => {
    const c = $('lc' + i).getContext('2d'), values = m.hist, present = values.filter(Number.isFinite);
    if (present.length < 2) { noHistory(c, 116, 28); return; }
    const mx = Math.max(0.1, ...present);
    let active = false;
    c.beginPath(); values.forEach((h, k) => {
      if (!Number.isFinite(h)) { active = false; return; }
      const x = k / Math.max(values.length - 1, 1) * 116, y = 27 - h / mx * 26;
      active ? c.lineTo(x, y) : c.moveTo(x, y);
      active = true;
    });
    c.strokeStyle = m.state < 2 ? '#ff4fd8' : '#ff3b5c'; c.lineWidth = 2; c.stroke();
  });
  const all = model.llmAll, split = splitByClass(all, model.llmLocalNames);
  const summary = (models) => {
    if (!models.length) return '0/0 UP · — tok/s';
    const up = models.filter((m) => m.state < 2).length;
    const rate = !model.llmTokFailed && models.every((m) => Number.isFinite(m.tok)) ? models.reduce((a, m) => a + m.tok, 0).toFixed(0) : '—';
    return `${up}/${models.length} UP · ${rate} tok/s`;
  };
  $('llmsum').textContent = model.llmClassFailed ? 'LOCAL — · CLOUD —'
    : all.length ? `LOCAL ${summary(split.local)} · CLOUD ${summary(split.cloud)}` : '—';
}

function renderWan() {
  const rate = (bytesPerSecond) => bytesPerSecond == null ? '—' : (bytesPerSecond * 8 / 1e6).toFixed(1);
  const rows = model.wan.map((port, i) => `WAN ${i + 1} &darr;<b>${rate(port.down)}</b> / &uarr;<b>${rate(port.up)}</b> Mbps`);
  $('wanrates').innerHTML = rows.length ? rows.join('<br>') : '—';
  const failed = model.wanRxFailed || model.wanTxFailed;
  const hasRate = model.wan.some((port) => port.down != null || port.up != null);
  const incomplete = model.wan.some((port) => port.down == null || port.up == null);
  setState($('wan'), failed ? 'error' : hasRate ? 'ok' : 'empty',
    failed ? 'WAN RATE QUERY FAILED' : !hasRate ? 'WAN METRICS EMPTY' : incomplete ? 'WAN METRICS INCOMPLETE' : '');
}

/* ---------------- honeycomb ---------------- */
const hx = $('hex');
// #hex is CSS-sized (position:absolute;inset:0;width:100%;height:100%, mc1.css) — its layout
// size never depends on its own attribute. The backing store is sized from the #apps CELL via
// a ResizeObserver (lib/stage.js observeCanvas), so drawHex below only ever reads hx.width/
// hx.height, never writes them — that self-reference (read the canvas's own rendered size,
// write it back as its resolution, which is itself part of what determines the rendered size)
// is what grew the panel without bound.
observeCanvas($('apps'), hx);
function drawHex(t) {
  const W = hx.width, H = hx.height;
  const c = hx.getContext('2d'); c.clearRect(0, 0, W, H);
  apps.forEach((a) => { a.d = a.s == null ? null : lerp(a.d ?? a.s, a.s, 0.1); });
  const n = Math.max(hexCells.length, 1), cols = n > 56 ? 9 : n > 42 ? 8 : 7;
  const r = W / (cols * Math.sqrt(3) + Math.sqrt(3) / 2), w = Math.sqrt(3) * r, rowsN = Math.ceil(n / cols), vh = r * 1.5 * 0.92;
  const oy = Math.max(r, (H - (rowsN - 1) * vh - 2 * r) / 2 + r);
  hexCells.forEach((a, i) => {
    const row = i / cols | 0, col = i % cols;
    if (!a) return; // gap cell between groups — reserved grid space, nothing drawn
    const hasScore = a.d != null, colr = hasScore ? hue(scorePct(a.d)) : '#2a4556';
    const x = w / 2 + col * w + (row % 2 ? w / 2 : 0), wave = RM ? 0 : Math.sin(t / 700 - col * 0.6 - row * 0.45) * r * 0.12;
    const depth = r * 0.28 + (hasScore ? a.d / 10 * r * 0.22 : 0), y = oy + row * vh + wave;
    const pulse = hasScore && a.d < SCORE_DEGRADED_MIN ? Math.sin(t / 220 + i) * 0.5 + 0.5 : 0, pts = [];
    for (let k = 0; k < 6; k++) { const an = Math.PI / 3 * k + Math.PI / 6; pts.push([x + Math.cos(an) * (r - 5), y + Math.sin(an) * (r - 5) * 0.82]); }
    for (const [p, q] of [[0, 1], [1, 2], [5, 0]]) {
      c.beginPath(); c.moveTo(...pts[p]); c.lineTo(...pts[q]); c.lineTo(pts[q][0], pts[q][1] + depth); c.lineTo(pts[p][0], pts[p][1] + depth); c.closePath();
      const sg = c.createLinearGradient(0, pts[p][1], 0, pts[p][1] + depth); sg.addColorStop(0, colr.replace('55%', '28%').replace('35%)', '22%)')); sg.addColorStop(1, 'rgba(4,7,12,.95)');
      c.fillStyle = sg; c.fill(); c.strokeStyle = colr.replace('55%', '35%'); c.lineWidth = 1; c.stroke();
    }
    c.beginPath(); pts.forEach((p, k) => (k ? c.lineTo(...p) : c.moveTo(...p))); c.closePath();
    const g = c.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r); g.addColorStop(0, colr.replace('55%', '42%')); g.addColorStop(1, 'rgba(6,12,20,.95)');
    c.fillStyle = g; c.fill(); c.lineWidth = 3 + pulse * 4; c.strokeStyle = colr; c.shadowColor = colr; c.shadowBlur = 10 + pulse * 30; c.stroke(); c.shadowBlur = 0;
    if (hasScore) {
      const ang = t / 900 + i; c.beginPath(); c.ellipse(x, y, r * 0.62, r * 0.5, 0, ang, ang + Math.PI * 2 * a.d / 10); c.strokeStyle = colr; c.lineWidth = 2; c.globalAlpha = 0.55; c.stroke(); c.globalAlpha = 1;
    }
    c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = `600 ${r * 0.4}px "Chakra Petch",sans-serif`; c.fillText(hasScore ? String(Math.round(a.d)) : '—', x, y + r * 0.06);
    c.fillStyle = '#cfe9f5'; c.font = `${Math.min(r * 0.22, 22)}px "JetBrains Mono",monospace`; c.fillText(a.n.length > 11 ? a.n.slice(0, 10) + '…' : a.n, x, y + r * 0.38);
  });
}

// #appsum reflects apps[].s (fresh from refresh()), never apps[].d (the hex glyphs' own
// lerp-eased decorative decay, drawHex above) -- so it must be written the moment data arrives,
// synchronously from renderStatic(), not from inside the 30fps rAF loop that drives drawHex.
// It used to live in drawHex itself: correct on Chromium, where the next animation frame is
// effectively immediate, but under WebKit a starved/backgrounded rAF can lag several seconds
// (the summary sat on its placeholder "—" past a 5s test timeout under CI's 8-way parallel
// matrix) -- a symptom of coupling a data-driven summary to a decorative animation's schedule.
function renderAppSum() {
  const scores = apps.map((a) => a.s);
  const count = scores.filter((s) => s != null).length;
  if (!count) {
    $('appsum').textContent = '—';
    hx.dataset.unknownCount = String(apps.length);
    return;
  }
  const ok = scores.filter((s) => s != null && s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s != null && s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s != null && s < SCORE_DEGRADED_MIN).length;
  const missing = apps.length - count;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>${missing ? ` · ${missing} NO DATA` : ''}`;
  hx.dataset.unknownCount = String(apps.filter((a) => a.s == null).length);
}

/* ---------------- topology and firewall panels ---------------- */
const clusterHealth = (hub) => {
  const scores = hub.apps.map((name) => appIndex[name]?.s).filter((value) => value != null);
  return { score: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null, missing: hub.apps.length - scores.length };
};
function topologyLabelDetails(node) {
  let rates = '';
  if (node.type === 'vlan' || node.type === 'internet') rates = `RX ${formatMbps(node.rxBytes)} + TX ${formatMbps(node.txBytes)} Mbps`;
  if (node.type === 'device' || node.type === 'gateway') rates = `${formatMbps(node.bytesPerSecond)} Mbps`;
  if (node.hasGroup) {
    const health = clusterHealth(node), score = health.score == null ? '—' : Math.round(health.score);
    rates = [rates, `${node.apps.length} apps · health ${score}${health.missing ? ` · ${health.missing} no data` : ''}`].filter(Boolean).join(' · ');
  }
  return rates;
}
const topologyView = createTopologyView({ canvas: $('gl'), labels: $('labels'), reducedMotion: RM });
onDispose(() => topologyView.dispose());

function renderVlans() {
  const networkHubs = (model.topology?.nodes || []).filter((node) => node.type === 'vlan');
  const failed = model.vlanRxFailed || model.vlanTxFailed, rates = $('vlanrates');
  rates.innerHTML = failed || !networkHubs.length ? '—' : networkHubs.map((hub) =>
    `<div><b>${esc(hub.name)}</b> RX ${formatMbps(hub.rxBytes)} + TX ${formatMbps(hub.txBytes)} Mbps</div>`).join('');
  const incomplete = networkHubs.some((hub) => hub.rxBytes == null || hub.txBytes == null);
  setState($('vlans'), failed ? 'error' : networkHubs.length ? 'ok' : 'empty',
    failed ? 'VLAN RATE QUERY FAILED' : !networkHubs.length ? 'VLAN METRICS EMPTY' : incomplete ? 'VLAN METRICS INCOMPLETE' : '');
}

function renderFirewallColumn(container, rows) {
  const html = rows.map((row) => `<div class="fwrow"><span>${esc(row.name)}</span><em class="${row.action}">${esc(row.action)}</em><b>${(row.rate * 60).toFixed(1)} events/min</b></div>`);
  container.innerHTML = html.join('') || '<div class="fw-empty">—</div>';
  const first = container.querySelector('.fwrow'), rowHeight = first?.offsetHeight || 20;
  const column = container.parentElement, title = column.querySelector('h3');
  const capacity = Math.max(1, Math.floor((column.clientHeight - (title?.offsetHeight || 0) - 8) / rowHeight));
  if (rows.length > capacity) container.innerHTML = html.slice(0, capacity - 1).join('') + `<div class="fwrow fwmore">+${rows.length - capacity + 1} more</div>`;
}

function renderFirewall() {
  const data = model.firewall || { countries: [], flows: [], rules: [] };
  renderFirewallColumn($('fwdrops'), data.countries);
  const flowRows = [
    ...data.flows.map((row) => ({ ...row, name: `${row.name} · flow` })),
    ...data.rules.map((row) => ({ ...row, name: `${row.name} · rule` })),
  ];
  renderFirewallColumn($('fwflows'), flowRows);
  const hasRows = data.countries.length + data.flows.length + data.rules.length > 0;
  setState($('fw'), model.firewallFailed ? 'error' : hasRows ? 'ok' : 'no-feed',
    model.firewallFailed ? model.firewallError : '');
}

/* ---------------- boot ---------------- */
function renderStatic() {
  const scored = apps.some((app) => app.s != null);
  const unscored = apps.length - apps.filter((app) => app.s != null).length;
  buildNodes(); renderQuorum(); renderHeader(); renderStorage(); renderLlm();
  topologyView.setModel(model.topology || { nodes: [], edges: [], positions: {} }, topologyLabelDetails);
  const nodeFailed = model.gpuFailed || model.nodeMetricsFailed;
  const mappedGpu = model.nodes.filter((n) => n.hasGpu);
  const gpuMissing = mappedGpu.filter((n) => !Number.isFinite(n.gpu)).length;
  const gpuEmpty = mappedGpu.length > 0 && gpuMissing === mappedGpu.length;
  const nodeIncomplete = model.nodes.some((n) => n.pending || ['cpu', 'mem', 'load'].some((key) => !Number.isFinite(n[key]))) || gpuMissing > 0;
  const nodeMessage = nodeFailed
    ? model.gpuFailed ? 'GPU QUERY FAILED' : 'NODE METRICS QUERY FAILED'
    : gpuEmpty ? 'GPU METRICS EMPTY' : nodeIncomplete ? 'NODE METRICS INCOMPLETE' : '';
  setState($('nodes'), nodeFailed ? 'error' : gpuEmpty ? 'pending' : 'ok', nodeMessage);
  setState($('topo'), 'ok', '');
  renderWan();
  renderVlans();
  setState($('apps'), model.scoreFailed ? 'error' : scored ? 'ok' : 'empty',
    model.scoreFailed ? 'SCORE QUERY FAILED' : !scored ? 'NO SERVICE DATA' : unscored ? `${unscored} SERVICE SCORES EMPTY` : '');
  renderAppSum();
  const storageState = model.storageFailed ? 'error' : model.storage.length ? 'ok' : 'empty';
  setState($('storage'), storageState,
    model.storageFailed ? 'STORAGE QUERY FAILED' : !model.storage.length ? 'STORAGE METRICS EMPTY' : model.storageIncomplete ? 'STORAGE METRICS INCOMPLETE' : '');
  renderFirewall();
  const llmFailed = model.llmFailed || model.llmTokFailed || model.llmClassFailed;
  setState($('llm'), llmFailed ? 'error' : model.llm.length ? 'ok' : 'pending',
    model.llmClassFailed ? 'MODEL CLASS QUERY FAILED' : model.llmFailed ? 'ROUTER QUERY FAILED' : model.llmTokFailed ? 'TOKEN RATE QUERY FAILED' : model.llm.length ? '' : 'ROUTER METRICS EMPTY');
  const up = model.nodes.filter((n) => !n.pending && !n.stale).length;
  const scoreSummary = model.scoreFailed ? '—' : `${apps.filter((a) => a.s != null).length}/${apps.length}`;
  const modelClasses = splitByClass(model.llmAll, model.llmLocalNames);
  const modelsUp = model.llmFailed || model.llmClassFailed ? '— · —'
    : `${modelClasses.local.filter((m) => m.state < 2).length} · ${modelClasses.cloud.filter((m) => m.state < 2).length}`;
  $('fstats').innerHTML = `NODES UP<b>${model.cpuFailed ? '—' : up}</b><br>APPS SCORED<b>${scoreSummary}</b><br>MODELS UP<b>${modelsUp}</b><br>UPDATED<b>${new Date(model.updated).toTimeString().slice(0, 8)}</b>`;
}
const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
// The render loop (and the 'ready' postMessage it fires after its first frame — site/lib/
// stage.js) starts before the first data refresh resolves, not after: a slow/failing Prometheus
// query must never delay 'ready' past the rotator's probe window and get this page skipped as
// broken, the way an AI-panel query outage did to MC3.
let lastNodes = 0;
loop(30, (now, dt) => {
  topologyView.render(now, dt); drawHex(now);
  if (now - lastNodes > 100) { drawNodes(); lastNodes = now; }
});
const guardedRefresh = guardRefresh(refresh);
await guardedRefresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => guardedRefresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
