// Mission Control 1: estate overview, driven by live Prometheus data.
import { query, range, settle, shortHost } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { clamp, hue, lerp, esc, fitStage, hardwareGL, loop, loadConfig, setState } from '/lib/stage.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
fitStage(stage);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = (cfg.groups || []).map((g, i) => ({ ...g, c: PALETTE[i % PALETTE.length] }));
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null, d: 0 }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { nodes: [], storage: [], llm: [], llmAll: [], uptime: null, updated: 0 };

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
    hist: () => range(Q.nodeCpu, 30, 30),
    fsSize: () => query(Q.fsSize),
    fsAvail: () => query(Q.fsAvail),
    llmState: () => query(Q.llmState),
    llmTok: () => query(Q.llmTokRate),
  });

  // settle() (lib/prom.js) yields null for a query that rejected (bad status, timeout, bad
  // body) — distinct from a query that succeeded with zero rows. A failed score query must
  // never render as "0 OK / 54 NO DATA"; it renders as an explicit error instead.
  model.scoreFailed = r.score === null;
  if (r.score) {
    const seen = new Set();
    for (const row of r.score) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 100); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
  model.uptime = r.uptime?.[0]?.value ?? null;

  if (r.cpu) {
    const [cores, mem, memT, load, temp, upt] = [r.cores, r.mem, r.memTotal, r.load, r.temp, r.upt].map(byHost);
    const hist = Object.fromEntries((r.hist || []).map((h) => [shortHost(h.labels.instance), h.values]));
    const live = r.cpu.map((row) => shortHost(row.labels.instance)).sort();
    model.nodes = live.map((name) => {
      const prev = model.nodes.find((n) => n.name === name) || {};
      return {
        ...prev, name,
        // D2: a role mapping that just echoes the node's own name back is not information —
        // the subtitle omits it rather than showing "node-c · node-c".
        role: cfg.nodeRoles?.[name] === name ? '' : (cfg.nodeRoles?.[name] || ''),
        cpu: byHost(r.cpu)[name], mem: mem[name], load: load[name], cores: cores[name] || 1,
        ram: memT[name] || 0, temp: temp[name], up: upt[name], hist: hist[name] || [],
        d: prev.d || { cpu: 0, mem: 0, load: 0 },
      };
    });
    for (const x of cfg.extraNodes || []) {
      if (!live.includes(x.name)) model.nodes.push({ name: x.name, role: x.role, pending: true, d: { cpu: 0, mem: 0, load: 0 } });
    }
  }

  model.storageFailed = r.fsSize === null || r.fsAvail === null;
  if (r.fsSize && r.fsAvail) {
    const avail = Object.fromEntries(r.fsAvail.map((x) => [`${x.labels.instance}|${x.labels.device}`, x.value]));
    const best = new Map(), hosts = new Map();
    for (const x of r.fsSize) {
      const zfs = x.labels.fstype === 'zfs';
      const host = shortHost(x.labels.instance);
      const name = zfs ? x.labels.device.split('/')[0] : x.labels.mountpoint;
      const size = x.value, used = size - (avail[`${x.labels.instance}|${x.labels.device}`] ?? size);
      const key = zfs ? `zfs:${name}` : `${x.labels.device}|${x.labels.mountpoint}`;
      if (size <= 1e9) continue;
      // D3: the same device + mountpoint reported by several nodes is one shared mount, not
      // several — keep the largest reading and remember every host that reported it.
      if (!(best.get(key)?.size >= size)) best.set(key, { host, name, size, used });
      if (!hosts.has(key)) hosts.set(key, new Set());
      hosts.get(key).add(host);
    }
    model.storage = [...best].map(([key, v]) => ({ ...v, host: hosts.get(key).size > 1 ? 'shared' : v.host }))
      .sort((a, b) => b.size - a.size).slice(0, 12);
  }

  model.llmFailed = r.llmState === null;
  if (r.llmState) {
    const tok = Object.fromEntries((r.llmTok || []).map((x) => [x.labels.model, x.value]));
    model.llmAll = r.llmState.map((x) => {
      const n = x.labels.litellm_model_name;
      const prev = model.llmAll?.find((m) => m.n === n);
      const t = tok[n] ?? 0;
      return { n, state: x.value, tok: t, hist: [...(prev?.hist || Array(29).fill(0)), t].slice(-30) };
    }).sort((a, b) => b.state - a.state || b.tok - a.tok || a.n.localeCompare(b.n));
    model.llm = model.llmAll.slice(0, 9);
  }
  model.updated = Date.now();
  renderStatic();
}

/* ---------------- header ---------------- */
const TB = 1e12, GB = 1e9;
function renderHeader() {
  const cores = model.nodes.reduce((a, n) => a + (n.pending ? 0 : n.cores || 0), 0);
  const ram = model.nodes.reduce((a, n) => a + (n.ram || 0), 0);
  const raw = model.storage.reduce((a, s) => a + s.size, 0);
  const k = [
    ['guests', esc(cfg.guestCount ?? '—'), ''], ['cores', cores || '—', ''], ['RAM', ram ? Math.round(ram / GB) : '—', 'GB'],
    ['raw', raw ? (raw / TB).toFixed(1) : '—', 'TB'], ['apps', apps.length, ''],
    ['uptime 24h', model.uptime != null ? model.uptime.toFixed(2) : '—', '%'],
  ];
  $('kpis').innerHTML = k.map(([l, v, u]) => `<div class="kpi"><b class="num">${v}<i>${u}</i></b><span>${l}</span></div>`).join('');
  const scored = apps.filter((a) => a.s != null);
  ring($('estateRing'), scored.length ? scored.reduce((a, x) => a + x.s, 0) / scored.length : null);
  $('subtitle').textContent = `${model.nodes.filter((n) => !n.pending).length} NODES · ${groups.length} GROUPS · ${apps.length} APPS`;
}
function ring(el, score) {
  const c = el.getContext('2d'); c.clearRect(0, 0, 128, 128); c.lineWidth = 10;
  c.strokeStyle = '#0d2233'; c.beginPath(); c.arc(64, 64, 52, 0, 7); c.stroke();
  if (score != null) {
    c.strokeStyle = hue(score); c.shadowColor = hue(score); c.shadowBlur = 14;
    c.beginPath(); c.arc(64, 64, 52, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score / 100); c.stroke(); c.shadowBlur = 0;
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
  $('nodelist').style.gridTemplateRows = `repeat(${Math.max(model.nodes.length, 1)},1fr)`;
  $('nodelist').innerHTML = model.nodes.map((n, i) => `<div class="node${n.pending ? ' mac' : ''}"><div class="nm">${esc(n.name.toUpperCase())}<em id="nm${i}"></em></div>
    ${[0, 1, 2, 3].map((g) => `<canvas class="g" id="g${i}${g}" width="240" height="168"></canvas>`).join('')}
    <canvas class="sp" id="sp${i}" width="780" height="52"></canvas></div>`).join('');
  const up = model.nodes.filter((n) => !n.pending).length;
  $('quorum').textContent = `${up}/${model.nodes.length} UP`;
}
function gauge(id, val, max, label, unit, col) {
  const el = $(id); if (!el) return;
  const c = el.getContext('2d'); c.clearRect(0, 0, 240, 168);
  const cx = 120, cy = 100, r = 66, a0 = Math.PI * 0.75, span = Math.PI * 1.5, f = val == null ? 0 : clamp(val / max, 0, 1);
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
  c.fillText(val == null ? '—' : val.toFixed(unit === '%' ? 0 : 1), cx, cy + 6);
  c.fillStyle = '#5d7d90'; c.font = '15px "JetBrains Mono",monospace'; c.fillText(label + (unit === '%' ? ' %' : ''), cx, cy + 34);
}
function spark(id, h) {
  const el = $(id); if (!el) return;
  const c = el.getContext('2d'), W = 780, H = 52; c.clearRect(0, 0, W, H);
  if (h.length < 2) return;
  const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(62,230,255,.35)'); g.addColorStop(1, 'rgba(62,230,255,0)');
  c.beginPath(); h.forEach((v, i) => { const x = i / (h.length - 1) * W, y = H - clamp(v, 0, 100) / 100 * H; i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = '#3ee6ff'; c.lineWidth = 2; c.stroke(); c.lineTo(W, H); c.lineTo(0, H); c.fillStyle = g; c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(W - 4, H - clamp(h[h.length - 1], 0, 100) / 100 * H, 4, 0, 7); c.fill();
}
function drawNodes() {
  model.nodes.forEach((n, i) => {
    for (const k of ['cpu', 'mem', 'load']) n.d[k] = n[k] == null ? null : lerp(n.d[k] ?? 0, n[k], 0.15);
    const d = n.d;
    gauge(`g${i}0`, d.cpu, 100, 'CPU', '%', hue(100 - (d.cpu ?? 0)));
    gauge(`g${i}1`, d.mem, 100, 'MEM', '%', hue(100 - (d.mem ?? 0)));
    gauge(`g${i}2`, d.load, n.cores || 1, 'LOAD', '', hue(100 - (d.load ?? 0) / (n.cores || 1) * 100));
    gauge(`g${i}3`, null, 100, n.pending ? 'PENDING' : 'NO GPU', '%', '#2a4556');
    spark(`sp${i}`, n.hist || []);
    const meta = n.pending ? `${n.role} · exporter pending`
      : `${n.role ? n.role + ' · ' : ''}${n.temp != null ? Math.round(n.temp) + '°C · ' : ''}${n.up != null ? 'up ' + Math.floor(n.up / 86400) + 'd' : ''}`;
    const el = $('nm' + i); if (el && el.textContent !== meta) el.textContent = meta;
  });
}

/* ---------------- storage ---------------- */
function renderStorage() {
  const fmt = (b) => (b >= TB ? (b / TB).toFixed(1) + 'T' : Math.round(b / GB) + 'G');
  $('strows').innerHTML = model.storage.length ? model.storage.map((s) => {
    const p = s.used / s.size * 100, col = hue(100 - p);
    return `<div class="st"><span>${esc(s.host)} <em>${esc(s.name)}</em></span><div class="bar"><div style="width:${p}%;background:linear-gradient(90deg,${col.replace('hsl', 'hsla').replace(')', ',.2)')},${col});box-shadow:0 0 10px ${col}"></div></div><span class="v num"><b>${p.toFixed(0)}%</b> ${fmt(s.size)}</span></div>`;
  }).join('') : '<div class="st pending">storage metrics pending</div>';
  const tot = model.storage.reduce((a, s) => a + s.size, 0), used = model.storage.reduce((a, s) => a + s.used, 0);
  $('sttot').textContent = tot ? `${(used / TB).toFixed(1)} / ${(tot / TB).toFixed(1)} TB` : '—';
}

/* ---------------- LLM panel ---------------- */
function renderLlm() {
  if (!model.llm.length) { $('llmrows').innerHTML = '<div class="pending">router metrics pending</div>'; $('llmsum').textContent = '—'; return; }
  $('llmrows').innerHTML = model.llm.map((m, i) => {
    const up = m.state < 2, col = m.state === 0 ? (m.tok > 0 ? '#38ff9c' : '#3ee6ff') : m.state === 1 ? '#ffb347' : '#ff3b5c';
    return `<div class="lr"><i style="background:${col};box-shadow:0 0 8px ${col}"></i><span title="${esc(m.n)}">${esc(m.n.split('/').pop())}</span><canvas id="lc${i}" width="116" height="28"></canvas><span class="tk" style="color:${up ? '#fff' : '#ff3b5c'}">${!up ? 'DOWN' : m.tok > 0.05 ? m.tok.toFixed(0) + ' t/s' : 'idle'}</span><span class="h">${['ok', 'degraded', 'outage'][m.state] || '?'}</span></div>`;
  }).join('');
  model.llm.forEach((m, i) => {
    const c = $('lc' + i).getContext('2d'), mx = Math.max(10, ...m.hist);
    c.beginPath(); m.hist.forEach((h, k) => { const x = k / 29 * 116, y = 27 - h / mx * 26; k ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = m.state < 2 ? '#ff4fd8' : '#ff3b5c'; c.lineWidth = 2; c.stroke();
  });
  const all = model.llmAll, up = all.filter((m) => m.state < 2).length;
  $('llmsum').textContent = `${up}/${all.length} UP · ${all.reduce((a, m) => a + m.tok, 0).toFixed(0)} tok/s`;
}

/* ---------------- honeycomb ---------------- */
const hx = $('hex');
function drawHex(t) {
  // #hex is CSS-sized (position:absolute;inset:0;width:100%;height:100%, mc1.css) — its layout
  // size never depends on this attribute. clientWidth/clientHeight only ever reads that fixed
  // CSS size, so writing the backing-store resolution here cannot feed back into it.
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.round(hx.clientWidth * dpr), H = Math.round(hx.clientHeight * dpr);
  if (hx.width !== W || hx.height !== H) { hx.width = W; hx.height = H; }
  const c = hx.getContext('2d'); c.clearRect(0, 0, W, H);
  for (const a of apps) a.d = lerp(a.d, a.s ?? 0, 0.1);
  const n = Math.max(apps.length, 1), cols = n > 56 ? 9 : n > 42 ? 8 : 7;
  const r = W / (cols * Math.sqrt(3) + Math.sqrt(3) / 2), w = Math.sqrt(3) * r, rowsN = Math.ceil(n / cols), vh = r * 1.5 * 0.92;
  const oy = Math.max(r, (H - (rowsN - 1) * vh - 2 * r) / 2 + r);
  apps.forEach((a, i) => {
    const row = i / cols | 0, col = i % cols, unknown = a.s == null, colr = unknown ? 'hsl(200,15%,35%)' : hue(a.d);
    const x = w / 2 + col * w + (row % 2 ? w / 2 : 0), wave = RM ? 0 : Math.sin(t / 700 - col * 0.6 - row * 0.45) * r * 0.12;
    const depth = r * 0.28 + (unknown ? 0 : a.d / 100) * r * 0.22, y = oy + row * vh + wave;
    const pulse = !unknown && a.d < 50 ? Math.sin(t / 220 + i) * 0.5 + 0.5 : 0, pts = [];
    for (let k = 0; k < 6; k++) { const an = Math.PI / 3 * k + Math.PI / 6; pts.push([x + Math.cos(an) * (r - 5), y + Math.sin(an) * (r - 5) * 0.82]); }
    for (const [p, q] of [[0, 1], [1, 2], [5, 0]]) {
      c.beginPath(); c.moveTo(...pts[p]); c.lineTo(...pts[q]); c.lineTo(pts[q][0], pts[q][1] + depth); c.lineTo(pts[p][0], pts[p][1] + depth); c.closePath();
      const sg = c.createLinearGradient(0, pts[p][1], 0, pts[p][1] + depth); sg.addColorStop(0, colr.replace('55%', '28%').replace('35%)', '22%)')); sg.addColorStop(1, 'rgba(4,7,12,.95)');
      c.fillStyle = sg; c.fill(); c.strokeStyle = colr.replace('55%', '35%'); c.lineWidth = 1; c.stroke();
    }
    c.beginPath(); pts.forEach((p, k) => (k ? c.lineTo(...p) : c.moveTo(...p))); c.closePath();
    const g = c.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r); g.addColorStop(0, colr.replace('55%', '42%')); g.addColorStop(1, 'rgba(6,12,20,.95)');
    c.fillStyle = g; c.fill(); c.lineWidth = 3 + pulse * 4; c.strokeStyle = colr; c.shadowColor = colr; c.shadowBlur = 10 + pulse * 30; c.stroke(); c.shadowBlur = 0;
    if (!unknown) { const ang = t / 900 + i; c.beginPath(); c.ellipse(x, y, r * 0.62, r * 0.5, 0, ang, ang + Math.PI * 2 * a.d / 100); c.strokeStyle = colr; c.lineWidth = 2; c.globalAlpha = 0.55; c.stroke(); c.globalAlpha = 1; }
    c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = `600 ${r * 0.4}px "Chakra Petch",sans-serif`; c.fillText(unknown ? '?' : Math.round(a.d), x, y + r * 0.06);
    c.fillStyle = '#cfe9f5'; c.font = `${Math.min(r * 0.22, 22)}px "JetBrains Mono",monospace`; c.fillText(a.n.length > 11 ? a.n.slice(0, 10) + '…' : a.n, x, y + r * 0.38);
  });
  const ok = apps.filter((a) => a.s != null && a.s >= 90).length, warn = apps.filter((a) => a.s != null && a.s >= 50 && a.s < 90).length;
  const bad = apps.filter((a) => a.s != null && a.s < 50).length, unk = apps.filter((a) => a.s == null).length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>${unk ? ` · <span style="color:var(--dim)">${unk} NO DATA</span>` : ''}`;
}

/* ---------------- topology (3D, or 2D on software GL) ---------------- */
const topo = $('topo'), labels = $('labels');
const clusterHealth = (g) => { const s = g.apps.map((n) => appIndex[n]?.s).filter((v) => v != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const labelEls = groups.map((g) => { const el = document.createElement('div'); el.className = 'vl'; el.style.color = g.c; labels.appendChild(el); return el; });
function updateLabels() {
  groups.forEach((g, i) => {
    const h = clusterHealth(g);
    const html = `${esc(g.name.toUpperCase())}<small>${g.apps.length} apps · health <span style="color:${h == null ? '#5d7d90' : hue(h)}">${h == null ? '—' : Math.round(h)}</span></small>`;
    if (labelEls[i].innerHTML !== html) labelEls[i].innerHTML = html;
  });
}
$('legend').innerHTML = groups.map((g) => `<span style="color:${g.c}"><i></i><span style="color:var(--dim)">${esc(g.name)}</span></span>`).join('');

let drawTopo;
const forced = new URLSearchParams(location.search).get('gl');
if (window.THREE && (forced === '3d' || (forced !== '2d' && hardwareGL()))) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x04070c, 0.0065);
  const cam = new THREE.PerspectiveCamera(48, 1, 1, 1000);
  const gc = document.createElement('canvas'); gc.width = gc.height = 64;
  { const x = gc.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); }
  const GT = new THREE.CanvasTexture(gc);
  const sprite = (col, size) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GT, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); s.scale.set(size, size, 1); return s; };
  const grid = new THREE.GridHelper(400, 40, 0x0f3a55, 0x0a2233); grid.position.y = -38; scene.add(grid);
  const stars = []; for (let i = 0; i < 1500; i++) stars.push((Math.random() - 0.5) * 800, Math.random() * 400 - 100, (Math.random() - 0.5) * 800);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x2a6c8a, size: 1.2 })));
  const core = new THREE.Group(); scene.add(core);
  const ico = new THREE.Mesh(new THREE.IcosahedronGeometry(9, 1), new THREE.MeshBasicMaterial({ color: 0x3ee6ff, wireframe: true, transparent: true, opacity: 0.8 })); core.add(ico);
  core.add(sprite(0x3ee6ff, 46));
  const rings = [0, 1, 2].map((i) => { const t = new THREE.Mesh(new THREE.TorusGeometry(15 + i * 5, 0.25, 6, 90), new THREE.MeshBasicMaterial({ color: 0x3ee6ff, transparent: true, opacity: 0.35 - i * 0.08 })); t.rotation.x = Math.PI / 2 + (i - 1) * 0.3; core.add(t); return t; });
  const flows = [], hubs = [];
  groups.forEach((g, i) => {
    const a = i / groups.length * Math.PI * 2, rad = 72, col = new THREE.Color(g.c), n = Math.min(g.apps.length, 18);
    const hub = new THREE.Group(); hub.position.set(Math.cos(a) * rad, (i % 3 - 1) * 10, Math.sin(a) * rad); scene.add(hub);
    hub.add(sprite(col, 26)); hub.add(new THREE.Mesh(new THREE.OctahedronGeometry(3.2), new THREE.MeshBasicMaterial({ color: col, wireframe: true })));
    const ring = new THREE.Mesh(new THREE.RingGeometry(13, 13.4, 64), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })); ring.rotation.x = Math.PI / 2; hub.add(ring);
    const lp = [];
    for (let k = 0; k < n; k++) {
      const y = 1 - (k / Math.max(n - 1, 1)) * 2, rr = Math.sqrt(Math.max(0, 1 - y * y)), th = k * 2.399963;
      const p = new THREE.Vector3(Math.cos(th) * rr * 11, y * 8, Math.sin(th) * rr * 11);
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 8), new THREE.MeshBasicMaterial({ color: col })); m.position.copy(p); hub.add(m);
      const gs = sprite(col, 5); gs.position.copy(p); hub.add(gs); lp.push(0, 0, 0, p.x, p.y, p.z);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    hub.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 })));
    const mid = hub.position.clone().multiplyScalar(0.5); mid.y += 18;
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), mid, hub.position.clone());
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.28 })));
    const N = 22, pos = new Float32Array(N * 3), pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ map: GT, color: col, size: 4.2, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    flows.push({ g, curve, pos, pg, ph: Array.from({ length: N }, () => ({ t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1 })) });
    hubs.push({ hub, ring, el: labelEls[i] });
  });
  const resize = () => { const w = topo.clientWidth, h = topo.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  resize(); addEventListener('resize', resize);
  const v3 = new THREE.Vector3();
  drawTopo = (now, dt) => {
    const tt = now / 1000, ang = RM ? 0.6 : tt * 0.06;
    cam.position.set(Math.cos(ang) * 138, 66 + Math.sin(tt * 0.2) * 8, Math.sin(ang) * 138); cam.lookAt(0, 4, 0);
    ico.rotation.y += 0.004; ico.rotation.x += 0.002; rings.forEach((r, i) => { r.rotation.z += (i % 2 ? 1 : -1) * 0.004; });
    flows.forEach((f) => {
      const h = clusterHealth(f.g), sp = 0.08 + (h ?? 50) / 400;
      f.ph.forEach((p, k) => { p.t = (p.t + dt * sp * p.dir + 1) % 1; const q = f.curve.getPoint(p.t); f.pos[k * 3] = q.x; f.pos[k * 3 + 1] = q.y; f.pos[k * 3 + 2] = q.z; });
      f.pg.attributes.position.needsUpdate = true;
    });
    hubs.forEach((h, i) => {
      h.hub.rotation.y += 0.003 + i * 0.0004; h.ring.scale.setScalar(1 + Math.sin(tt * 2 + i) * 0.06);
      h.hub.getWorldPosition(v3); v3.project(cam);
      h.el.style.left = ((v3.x + 1) / 2 * topo.clientWidth) + 'px'; h.el.style.top = ((1 - v3.y) / 2 * topo.clientHeight) + 'px'; h.el.style.opacity = v3.z < 1 ? 1 : 0;
    });
    renderer.render(scene, cam);
  };
} else {
  // 2D fallback: clusters orbit a core on a plain canvas.
  $('topostate').textContent = '2D MODE';
  const cv = $('gl'), c = cv.getContext('2d');
  drawTopo = (now) => {
    const w = cv.width = topo.clientWidth, h = cv.height = topo.clientHeight, cx = w / 2, cy = h / 2 + 20;
    c.clearRect(0, 0, w, h);
    groups.forEach((g, i) => {
      const a = i / groups.length * Math.PI * 2 + (RM ? 0 : now / 30000), x = cx + Math.cos(a) * w * 0.3, y = cy + Math.sin(a) * h * 0.28;
      c.strokeStyle = g.c; c.globalAlpha = 0.3; c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke(); c.globalAlpha = 1;
      const p = (now / 2000 + i / groups.length) % 1; c.fillStyle = g.c; c.beginPath(); c.arc(cx + (x - cx) * p, cy + (y - cy) * p, 3, 0, 7); c.fill();
      c.beginPath(); c.arc(x, y, 18, 0, 7); c.stroke();
      labelEls[i].style.left = x + 'px'; labelEls[i].style.top = y + 'px';
    });
    c.strokeStyle = '#3ee6ff'; c.beginPath(); c.arc(cx, cy, 24, 0, 7); c.stroke();
  };
}

/* ---------------- firewall + WAN (feed arrives with the Splunk app) ---------------- */
$('blkrows').innerHTML = '<div class="pending" style="padding:14px">edge block feed pending</div>';
$('fwrows').innerHTML = '<div class="pending" style="padding:14px">flow feed pending</div>';

/* ---------------- boot ---------------- */
function renderStatic() {
  buildNodes(); renderHeader(); renderStorage(); renderLlm(); updateLabels();
  setState($('nodes'), 'pending', 'NO GPU EXPORTER');
  setState($('topo'), 'pending', 'WAN EXPORTER PENDING');
  // D5: an app with no Gatus series at all is "no data" for that one cell (see drawHex/appsum),
  // never reason to pend the whole panel — only a total scoring failure does.
  // A query that failed outright (settle() -> null) is 'error', never silently "no data".
  const scored = apps.some((app) => app.s != null);
  setState($('apps'), model.scoreFailed ? 'error' : scored ? 'ok' : 'empty',
    model.scoreFailed ? 'SCORE QUERY FAILED' : scored ? '' : 'NO SERVICE DATA');
  setState($('storage'), model.storageFailed ? 'error' : model.storage.length ? 'ok' : 'empty',
    model.storageFailed ? 'STORAGE QUERY FAILED' : model.storage.length ? '' : 'STORAGE METRICS EMPTY');
  setState($('fw'), 'pending', 'SPLUNK FEED PENDING');
  setState($('llm'), model.llmFailed ? 'error' : model.llm.length ? 'ok' : 'pending',
    model.llmFailed ? 'ROUTER QUERY FAILED' : model.llm.length ? '' : 'ROUTER METRICS PENDING');
  const up = model.nodes.filter((n) => !n.pending).length;
  $('fstats').innerHTML = `NODES UP<b>${up}</b><br>APPS SCORED<b>${apps.filter((a) => a.s != null).length}/${apps.length}</b><br>MODELS UP<b>${model.llm.filter((m) => m.state < 2).length}</b><br>UPDATED<b>${new Date(model.updated).toTimeString().slice(0, 8)}</b>`;
}
const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock(); setInterval(tickClock, 1000);
await refresh().catch((e) => console.warn('refresh', e));
setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
let lastNodes = 0;
loop(30, (now, dt) => {
  drawTopo(now, dt); drawHex(now);
  if (now - lastNodes > 100) { drawNodes(); lastNodes = now; }
});
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
