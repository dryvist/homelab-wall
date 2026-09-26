// Mission Control 4: media acquisition.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  clamp, esc, loadConfig, setState, loop, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setSampleBadge,
  setStandIn, onDispose, onContextLoss, disposeThreeScene, hardwareGL,
} from '/lib/stage.js';
import { sampleAppScore, SAMPLE_ACQ_CARDS, SAMPLE_LIBRARY_CARDS } from '/lib/sampleData.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = cfg.groups || [];
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { fleetUpFrac: null }; // drives the hero scene's brightness/motion (real signal)

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

/* ---------------- service health (real; condensed into the header strip, not a centre list) ---------------- */
function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  // A query that succeeded with zero rows has genuinely nothing to show yet — render the shared
  // sample scores instead (badged), never layered on top of real (even partial) data.
  const sample = !scored.length;
  const display = apps.map((a, i) => (sample ? { n: a.n, s: sampleAppScore(i) } : a));
  const scores = display.map((a) => a.s).filter((s) => s != null);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length, warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length, bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = scores.length
    ? `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`
    : '';
  setSampleBadge($('apps'), sample);
  setState($('apps'), scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
  model.fleetUpFrac = scores.length ? ok / scores.length : null;
}

/* ---------------- stand-in panels — no download/library exporter exists yet ---------------- */
// No download-client/library/VPN/arr-stack exporter exists yet — stand-in content throughout,
// machine-flagged only (setStandIn: no visible badge/pending text — site/lib/stage.js). Never
// written into any live model, and never substituted for a real feed once one exists.
function card(title, note) {
  return `<div class="card"><div class="ct">${esc(title)}</div><div class="cn">${esc(note)}</div></div>`;
}
function statgrid(pairs) {
  return `<div class="card statgrid">${pairs.map(([l, v]) => `<div><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
}

// Download queue: a handful of generic in-progress items (never a real filename), each with a
// deterministic-but-varying progress bar and speed so the panel reads as active, not frozen.
const QUEUE_NAMES = ['collection.s01e04', 'archive-part-07', 'release.pack.2160p', 'media-item-12', 'bundle-vol-03'];
function renderQueue() {
  const el = $('queuerows');
  if (!el) return;
  const now = Date.now() / 1000;
  el.innerHTML = QUEUE_NAMES.map((n, i) => {
    const pct = Math.round(20 + ((now / (6 + i)) % 1) * 78);
    const mbps = (4 + ((now / (3 + i * 1.3)) % 1) * 38).toFixed(1);
    return `<div class="qrow"><span class="qn">${esc(n)}</span><span class="qs">${mbps} MB/s</span>
      <div class="qbar"><div style="width:${pct}%"></div></div></div>`;
  }).join('');
}

// Arr-stack activity: a scrolling feed of grab/import events. Titles are generic placeholders,
// never a real media name.
const ARR_ACTIONS = ['grabbed', 'imported', 'upgraded'];
const ARR_TITLES = ['Series Title S02E07', 'Feature Film (2024)', 'Series Title S04E01', 'Feature Film (2019)', 'Series Title S01E11'];
let arrTimer = null;
onDispose(() => { if (arrTimer) clearTimeout(arrTimer); });
function addArrRow(animate) {
  const action = ARR_ACTIONS[Math.floor(Math.random() * ARR_ACTIONS.length)];
  const title = ARR_TITLES[Math.floor(Math.random() * ARR_TITLES.length)];
  const row = document.createElement('div');
  row.className = animate ? 'afrow afrow-in' : 'afrow';
  row.textContent = `${action} · ${title}`;
  const feed = $('arrfeed');
  if (feed) {
    feed.prepend(row);
    while (feed.children.length > 18) feed.lastElementChild.remove();
  }
}
function scheduleArrFeed() {
  arrTimer = setTimeout(() => {
    arrTimer = null;
    addArrRow(true);
    scheduleArrFeed();
  }, RM ? 4000 : 1200 + Math.random() * 1800);
}

function renderAcqPanel() {
  const [qbit] = SAMPLE_ACQ_CARDS;
  $('acqbody').innerHTML = card(qbit.title, qbit.note)
    + `<div class="card"><div class="ct">Queue</div><div id="queuerows"></div></div>`
    + statgrid([['tunnel', 'up'], ['peers', '3'], ['handshake', '41s ago'], ['rx / tx', '1.2 / 0.3 GB']]);
  renderQueue();
}
function renderPipePanel() {
  const [plex, , storage] = SAMPLE_LIBRARY_CARDS;
  $('pipebody').innerHTML = card(plex.title, plex.note)
    + statgrid([['movies', '1,204'], ['shows', '86'], ['episodes', '9,417'], ['added (7d)', '23']])
    + `<div class="card" style="flex:1;min-height:0;display:flex;flex-direction:column"><div class="ct">Arr activity</div><div class="afeed" id="arrfeed"></div></div>`
    + card(storage.title, storage.note);
}
renderAcqPanel();
renderPipePanel();
for (let i = 0; i < 6; i += 1) addArrRow(false); // seed so the feed isn't empty on first paint
scheduleArrFeed();
setState($('acq'), 'ok', '');
setState($('pipe'), 'ok', '');
setStandIn($('acq'), true);
setStandIn($('pipe'), true);
$('vpn').textContent = '● WIREGUARD · CONNECTED';
setStandIn($('vpn'), true);
const queueId = setInterval(renderQueue, 2000);
onDispose(() => clearInterval(queueId));

/* ---------------- centre hero: 3D acquisition flow (sketch scene 125) or 2D fallback ---------------- */
const corePanel = $('core');
const coreCanvas = $('corecanvas');
const forced = new URLSearchParams(location.search).get('gl');

function build3DFlow() {
  // alpha:false + opaque black clear, and a much higher bloom threshold/tighter radius: a
  // transparent canvas plus a low threshold (0.12) bloomed nearly every lit pixel, reading as a
  // colour fog wash across the whole panel instead of solid black with glow on the objects only
  // (same class of bug MC3's reactor hit).
  const renderer = new THREE.WebGLRenderer({ canvas: coreCanvas, antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  cam.position.set(0, 18, 130);
  cam.lookAt(0, 0, 0);
  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.0, radius: 0.32, threshold: 0.6 });

  const group = new THREE.Group(); scene.add(group);

  // Nested glowing tori around the core (sketch scene 125) — concentric rings at alternating
  // tilts, tinted through the same amber/green/cyan palette as the flow tubes below.
  const TORUS_COLS = [0xffb347, 0x38ff9c, 0x3ee6ff];
  const tori = Array.from({ length: 5 }, (_, i) => {
    const t = new THREE.Mesh(
      new THREE.TorusGeometry(16 + i * 5, 0.4, 8, 64),
      new THREE.MeshBasicMaterial({ color: TORUS_COLS[i % TORUS_COLS.length], transparent: true, opacity: 0.8 - i * 0.1 }),
    );
    t.rotation.x = Math.PI / 2 + i * 0.3; t.rotation.y = i * 0.5;
    group.add(t);
    return t;
  });
  const P = []; for (let i = 0; i < 260; i += 1) {
    const u = Math.random() * Math.PI * 2, v = Math.acos(Math.random() * 2 - 1), rr = 65 + Math.random() * 18;
    P.push(Math.sin(v) * Math.cos(u) * rr, Math.cos(v) * rr * 0.6, Math.sin(v) * Math.sin(u) * rr);
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  group.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffb347, size: 1.4, transparent: true, opacity: 0.8 })));

  const path1 = new THREE.CatmullRomCurve3([new THREE.Vector3(-100, 13, -26), new THREE.Vector3(-52, 26, 0), new THREE.Vector3(-17, 4, 17), new THREE.Vector3(0, 0, 0)]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(path1, 100, 4, 12, false), new THREE.MeshBasicMaterial({ color: 0x38ff9c, wireframe: true, transparent: true, opacity: 0.25 })));
  const path2 = new THREE.CatmullRomCurve3([new THREE.Vector3(100, -9, -26), new THREE.Vector3(52, -22, 9), new THREE.Vector3(17, -4, 17), new THREE.Vector3(0, 0, 0)]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(path2, 100, 2.6, 12, false), new THREE.MeshBasicMaterial({ color: 0x3ee6ff, wireframe: true, transparent: true, opacity: 0.18 })));

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(9.5, 1), new THREE.MeshBasicMaterial({ color: 0xffb347, wireframe: true }));
  group.add(core);
  const shield = new THREE.Mesh(new THREE.SphereGeometry(14.5, 24, 24), new THREE.MeshBasicMaterial({ color: 0x38ff9c, wireframe: true, transparent: true, opacity: 0.15 }));
  group.add(shield);

  const mkFlow = (curve, col, n, dir) => {
    const pos = new Float32Array(n * 3), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: col, size: 1.7, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    return { curve, pos, g, ph: Array.from({ length: n }, () => Math.random()), dir };
  };
  const flows = [mkFlow(path1, 0x38ff9c, 130, 1), mkFlow(path2, 0x3ee6ff, 65, -1)];

  // Accretion disk: two coplanar rings (a lit outer ring, a dim base underneath so the "gap" reads
  // as a disk rather than a flat circle).
  const disk = new THREE.Mesh(new THREE.RingGeometry(25, 31, 90, 1, 0, Math.PI * 2 * 0.86), new THREE.MeshBasicMaterial({ color: 0xffb347, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
  disk.rotation.x = -Math.PI / 2; disk.position.y = -17; scene.add(disk);
  const diskBase = new THREE.Mesh(new THREE.RingGeometry(25, 31, 90), new THREE.MeshBasicMaterial({ color: 0x3a2208, side: THREE.DoubleSide }));
  diskBase.rotation.x = -Math.PI / 2; diskBase.position.y = -17.2; scene.add(diskBase);

  const resizeAt = (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(() => { fitCanvas(coreCanvas); resizeAt(coreCanvas.width, coreCanvas.height); });
  ro.observe(corePanel);
  fitCanvas(coreCanvas); resizeAt(coreCanvas.width, coreCanvas.height);

  function render(now) {
    const t = RM ? 0 : now / 1000;
    // Brightness/spin tied to the real fleet up-fraction (model.fleetUpFrac) — the one live
    // signal this decorative scene has any business reflecting; never fabricated.
    const health = model.fleetUpFrac ?? 0.8;
    group.rotation.y = Math.sin(t * 0.15) * 0.35;
    core.rotation.y += 0.01; core.rotation.x += 0.004;
    shield.rotation.y -= 0.003; shield.scale.setScalar(1 + Math.sin(t * 3) * 0.03 * health);
    tori.forEach((tr, i) => { tr.rotation.z += 0.003 * (i % 2 ? -1 : 1) * (1 + i * 0.15) * (0.4 + health); });
    disk.rotation.z += 0.002; diskBase.rotation.z += 0.002;
    flows.forEach((f) => {
      f.ph.forEach((p, k) => {
        f.ph[k] = (p + 0.006 * f.dir + 1) % 1;
        const q = f.curve.getPoint(f.ph[k]);
        f.pos[k * 3] = q.x + (Math.random() - 0.5) * 3;
        f.pos[k * 3 + 1] = q.y + (Math.random() - 0.5) * 3;
        f.pos[k * 3 + 2] = q.z + (Math.random() - 0.5) * 3;
      });
      f.g.attributes.position.needsUpdate = true;
    });
    bloomFx.render();
  }
  return { render, renderer, scene, dispose: () => { bloomFx.dispose(); ro.disconnect(); } };
}

function fitCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

let drawCore;
if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  let flow3d = build3DFlow();
  drawCore = (now) => flow3d.render(now);
  onContextLoss(coreCanvas, () => {
    flow3d.dispose();
    disposeThreeScene(flow3d.renderer, flow3d.scene);
    flow3d = build3DFlow();
  });
  onDispose(() => { flow3d.dispose(); disposeThreeScene(flow3d.renderer, flow3d.scene); });
} else {
  const coreRO = new ResizeObserver(() => fitCanvas(coreCanvas));
  coreRO.observe(corePanel);
  onDispose(() => coreRO.disconnect());
  fitCanvas(coreCanvas);
  drawCore = (t) => {
    const w = coreCanvas.width, h = coreCanvas.height;
    if (!w || !h) return;
    const c = coreCanvas.getContext('2d');
    c.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, base = Math.max(w, h);
    const cols = ['rgba(255,179,71,.28)', 'rgba(56,255,156,.18)', 'rgba(62,230,255,.13)', 'rgba(255,179,71,.09)'];
    cols.forEach((col, i) => {
      const r = base * (0.16 + i * 0.1) + (RM ? 0 : Math.sin(t / 1800 + i) * base * 0.012);
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
    });
    c.fillStyle = 'rgba(255,179,71,.5)'; c.beginPath(); c.arc(cx, cy, base * 0.02, 0, Math.PI * 2); c.fill();
  };
}

/* ---------------- boot ---------------- */
const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
// The render loop (and the 'ready' postMessage it fires — site/lib/stage.js) starts before the
// first data refresh resolves, so a slow/failing query never delays 'ready' past the rotator's
// probe window.
loop(30, (now) => drawCore(now));
await refresh().catch((e) => console.warn('refresh', e));
renderApps();
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)).then(() => renderApps()), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
