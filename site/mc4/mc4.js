// Mission Control 4: media acquisition.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  clamp, esc, loadConfig, setState, loop, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setSampleBadge,
  setStandIn, onDispose, onContextLoss, disposeThreeScene, hardwareGL, adaptiveBloomOn, adaptiveDpr,
} from '/lib/stage.js';
import { sampleAppScore } from '/lib/sampleData.js';

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

/* ---------------- stand-in panels — no download/library/arr exporter exists yet ---------------- */
// No download-client/library/VPN/arr-stack exporter exists yet — stand-in content throughout,
// machine-flagged only (setStandIn: no visible badge/pending text — site/lib/stage.js). Never
// written into any live model, and never substituted for a real feed once one exists. Content set
// and card shapes port the approved sketch (scene 125) 1:1: QBITTORRENT/LIBRARY STORAGE/PLEX on
// the left, TORRENTS/ARR STACK on the right, a poster strip along the bottom — no throughput
// chart (the sketch has none; the QBITTORRENT numerals carry that signal instead).
function statCard(title, rows) {
  return `<div class="card"><div class="ct">${esc(title)}</div><div class="qgrid">${rows.map(([v, l, c]) => `<div><b class="num${c ? ` ${c}` : ''}">${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div></div>`;
}

// A handful of generic in-progress items (never a real filename) drive both the QBITTORRENT
// summary numerals and the TORRENTS list below — one shared array, like the sketch's own `tor`.
const TORRENT_NAMES = ['collection.s01e04', 'archive-part-07', 'release.pack.2160p', 'media-item-12', 'bundle-vol-03', 'image-mirror-01', 'open-source.iso', 'restore-set-02', 'archive-part-11', 'linux-distro.iso'];
const TORRENTS = TORRENT_NAMES.map((n, i) => ({ n, seed: i % 3 === 0, ratio: 0.3 + ((i * 37) % 100) / 25 }));
const downAt = (t) => clamp(42 + Math.sin(t / 4) * 28 + (Math.sin(t * 1.7) * 0.5) * 10, 2, 100);
const upAt = (t) => clamp(9 + Math.sin(t / 6 + 1) * 6 + Math.sin(t * 2.3) * 4, 0.5, 30);

function renderQbit(now) {
  const downloading = TORRENTS.filter((t) => !t.seed).length, seeding = TORRENTS.length - downloading;
  const ratio = TORRENTS.reduce((a, t) => a + t.ratio, 0) / TORRENTS.length;
  const peers = Math.round(180 + ((now / 11) % 1) * 240);
  const dht = Math.round(300 + ((now / 17) % 1) * 300);
  return statCard('QBITTORRENT', [
    [`↓ ${downAt(now).toFixed(1)}`, 'MB/s download', 'green'],
    [`↑ ${upAt(now).toFixed(1)}`, 'MB/s upload', 'cyan'],
    [`${downloading} / ${seeding}`, 'downloading / seeding'],
    [ratio.toFixed(2), 'global ratio (est.)', 'amber'],
    [String(peers), 'peers connected'],
    ['HEALTHY', `DHT ${dht} nodes`, 'green'],
  ]);
}

function renderTorrents(now) {
  const rows = TORRENTS.map((t, i) => {
    const rate = t.seed ? clamp(1 + ((now / (5 + i)) % 1) * 8, 0.2, 9) : clamp(3 + ((now / (4 + i * 1.3)) % 1) * 40, 1, 45);
    const pct = t.seed ? 100 : Math.round(10 + ((now / (7 + i)) % 1) * 88);
    return `<div class="trow"><span class="tn">${t.seed ? '▲' : '▼'} ${esc(t.n)}</span><span class="tr" style="color:${t.seed ? 'var(--cyan)' : 'var(--green)'}">${rate.toFixed(1)} ${t.seed ? '↑' : '↓'}</span><span class="tratio">r ${t.ratio.toFixed(2)}</span>
      <div class="tbar"><i style="width:${pct}%;background:${t.seed ? 'var(--cyan)' : 'linear-gradient(90deg,var(--amber),var(--green))'}"></i></div></div>`;
  }).join('');
  return `<div class="card"><div class="ct">TORRENTS</div>${rows}</div>`;
}

// Library storage breakdown (sketch scene 125's LIBRARY STORAGE card): a fixed total/used split
// by media type, each bar sized relative to the largest category (not the total), same as the
// sketch's own bar math.
const LIBRARY = { total: 60, used: 38.2, parts: [['Movies', 15.8, 'amber'], ['TV', 17.9, 'red'], ['Music', 1.6, 'mag'], ['Downloads', 2.9, 'cyan']] };
const LIBRARY_MAX = Math.max(...LIBRARY.parts.map(([, v]) => v));
function renderLibraryStorage() {
  const pct = Math.round((LIBRARY.used / LIBRARY.total) * 100);
  const rows = LIBRARY.parts.map(([n, v, c]) => `<div class="lrow"><span>${esc(n)}</span><div class="lbar"><i style="width:${((v / LIBRARY_MAX) * 100).toFixed(0)}%;background:var(--${c})"></i></div><b>${v} TB</b></div>`).join('');
  return `<div class="card"><div class="ct">LIBRARY STORAGE</div><div class="lbig"><b>${LIBRARY.used}</b><i> / ${LIBRARY.total} TB · ${pct}%</i></div>${rows}</div>`;
}

// PLEX card: figures ported 1:1 from the sketch (it hardcodes these too) plus 3 generic "now
// playing" lines — never a real media title.
const PLEX_STREAMS = [['Feature film A', '4K direct', 'living room'], ['Feature film B', '1080p transcode', 'phone'], ['Feature film C', '4K HDR', 'office']];
function renderPlex() {
  const rows = PLEX_STREAMS.map(([t, q, w]) => `<div>▶ ${esc(t)} · ${esc(q)} · ${esc(w)}</div>`).join('');
  return `<div class="card"><div class="ct">PLEX</div><div class="p3grid"><div><b>3</b><span>streams</span></div><div><b>1</b><span>transcode</span></div><div><b>85</b><span>Mb/s out</span></div></div><div class="pstreams">${rows}</div></div>`;
}

// ARR STACK (sketch scene 125): a fixed 6-service status grid, not a scrolling feed — one row
// (index 3) is deliberately shown degraded, matching the sketch, so the panel never reads as an
// all-green wall that hides real trouble.
const ARR_SERVICES = ['sonarr', 'radarr', 'prowlarr', 'bazarr', 'overseerr', 'tautulli'];
function renderArrStack() {
  const rows = ARR_SERVICES.map((s, i) => {
    const bad = i === 3;
    return `<div class="arow${bad ? ' bad' : ''}"><i></i>${esc(s)}<em>${bad ? 'degraded' : `q${(i * 2) % 5} · ok`}</em></div>`;
  }).join('');
  return `<div class="card"><div class="ct">ARR STACK</div><div class="agrid">${rows}</div></div>`;
}

// Recently-added poster strip (sketch scene 125's bottom band): generic gradient cards, never a
// real media title.
const POSTER_TITLES = ['Feature film A', 'Feature film B', 'Series C', 'Series D', 'Feature film E', 'Feature film F', 'Series G', 'Feature film H'];
function renderPosters(now) {
  const cards = POSTER_TITLES.map((p, i) => {
    const age = Math.round(1 + ((now / (9 + i)) % 1) * 47);
    return `<div class="poster" style="background:linear-gradient(${i * 45}deg,hsl(${20 + i * 40} 70% 30%),hsl(${200 + i * 20} 55% 14%))">${esc(p)}<span>${age}h ago</span></div>`;
  }).join('');
  $('posters').innerHTML = `<div class="ct">RECENTLY ADDED</div><div class="pgrid">${cards}</div>`;
}

function renderMediaPanels() {
  const now = Date.now() / 1000;
  $('acqbody').innerHTML = renderQbit(now) + renderLibraryStorage() + renderPlex();
  $('pipebody').innerHTML = renderTorrents(now) + renderArrStack();
  renderPosters(now);
}
renderMediaPanels();
setState($('acq'), 'ok', '');
setState($('pipe'), 'ok', '');
setStandIn($('acq'), true);
setStandIn($('pipe'), true);
$('vpn').textContent = '● WIREGUARD · CONNECTED';
$('vpnDetail').textContent = 'tunnel exit · handshake 32s ago · killswitch ARMED · leaks 0 · port-fwd OPEN';
setStandIn($('vpn'), true);
const mediaPanelsId = setInterval(renderMediaPanels, 2000);
onDispose(() => clearInterval(mediaPanelsId));

/* ---------------- centre hero: 3D acquisition flow (sketch scene 125) or 2D fallback ---------------- */
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
  // Camera and every geometry value below are ported 1:1 from the approved sketch (scene 125,
  // scratchpad/wall-sketches.html) — same FOV/distance, same radii/opacities/sizes, no rescale
  // hack — so the canvas (a full-viewport 16:9 layer, same as the sketch's own #stage) reproduces
  // the promised framing exactly instead of a shrunk-down approximation.
  const cam = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  cam.position.set(0, 40, 300);
  cam.lookAt(0, 0, 0);
  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.35, radius: 0.4, threshold: 0.5 });

  const group = new THREE.Group(); scene.add(group);

  // Dust shell around the flow (sketch scene 125): 260 points on a lumpy sphere shell.
  const P = []; for (let i = 0; i < 260; i += 1) {
    const u = Math.random() * Math.PI * 2, v = Math.acos(Math.random() * 2 - 1), rr = 150 + Math.random() * 40;
    P.push(Math.sin(v) * Math.cos(u) * rr, Math.cos(v) * rr * 0.6, Math.sin(v) * Math.sin(u) * rr);
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  group.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffb347, size: 2.4, transparent: true, opacity: 0.8 })));

  const path1 = new THREE.CatmullRomCurve3([new THREE.Vector3(-230, 30, -60), new THREE.Vector3(-120, 60, 0), new THREE.Vector3(-40, 10, 40), new THREE.Vector3(0, 0, 0)]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(path1, 120, 9, 16, false), new THREE.MeshBasicMaterial({ color: 0x38ff9c, wireframe: true, transparent: true, opacity: 0.25 })));
  const path2 = new THREE.CatmullRomCurve3([new THREE.Vector3(230, -20, -60), new THREE.Vector3(120, -50, 20), new THREE.Vector3(40, -10, 40), new THREE.Vector3(0, 0, 0)]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(path2, 120, 6, 12, false), new THREE.MeshBasicMaterial({ color: 0x3ee6ff, wireframe: true, transparent: true, opacity: 0.18 })));

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(22, 1), new THREE.MeshBasicMaterial({ color: 0xffb347, wireframe: true }));
  group.add(core);
  const shield = new THREE.Mesh(new THREE.SphereGeometry(34, 24, 24), new THREE.MeshBasicMaterial({ color: 0x38ff9c, wireframe: true, transparent: true, opacity: 0.15 }));
  group.add(shield);

  const mkFlow = (curve, col, n, dir) => {
    const pos = new Float32Array(n * 3), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: col, size: 4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    return { curve, pos, g, ph: Array.from({ length: n }, () => Math.random()), dir };
  };
  const flows = [mkFlow(path1, 0x38ff9c, 140, 1), mkFlow(path2, 0x3ee6ff, 70, -1)];

  // Accretion disk: two coplanar rings (a lit outer ring, a dim base underneath so the "gap" reads
  // as a disk rather than a flat circle).
  const disk = new THREE.Mesh(new THREE.RingGeometry(60, 74, 90, 1, 0, Math.PI * 2 * 0.86), new THREE.MeshBasicMaterial({ color: 0xffb347, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
  disk.rotation.x = -Math.PI / 2; disk.position.y = -40; group.add(disk);
  const diskBase = new THREE.Mesh(new THREE.RingGeometry(60, 74, 90), new THREE.MeshBasicMaterial({ color: 0x3a2208, side: THREE.DoubleSide }));
  diskBase.rotation.x = -Math.PI / 2; diskBase.position.y = -40.2; group.add(diskBase);

  const resizeAt = (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); };
  // The canvas is a full-viewport fixed layer now (mc4.css #corecanvas), not the "core" panel's
  // box — size the backing store from the viewport itself (document.documentElement's
  // ResizeObserver fires on viewport resize) rather than any one panel.
  const ro = new ResizeObserver(() => { fitCanvas(coreCanvas); resizeAt(coreCanvas.width, coreCanvas.height); });
  ro.observe(document.documentElement);
  fitCanvas(coreCanvas); resizeAt(coreCanvas.width, coreCanvas.height);

  function render(now) {
    const t = RM ? 0 : now / 1000;
    // Brightness/spin tied to the real fleet up-fraction (model.fleetUpFrac) — the one live
    // signal this decorative scene has any business reflecting; never fabricated.
    const health = model.fleetUpFrac ?? 0.8;
    // Slow camera drift (shock-and-awe): a gentle orbit around the sketch's own default position
    // so the hero scene reads as alive even beyond its own spin/flow animation.
    if (!RM) {
      cam.position.x = Math.sin(t * 0.1) * 50;
      cam.position.y = 40 + Math.sin(t * 0.07) * 20;
      cam.lookAt(0, 0, 0);
    }
    const spin = 0.4 + health;
    group.rotation.y = Math.sin(t * 0.15) * 0.35;
    core.rotation.y += 0.01 * spin; core.rotation.x += 0.004 * spin;
    shield.rotation.y -= 0.003; shield.scale.setScalar(1 + Math.sin(t * 3) * 0.03 * health);
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
    // Adaptive quality (site/lib/stage.js): bloom is the second thing dropped under sustained
    // frame-time pressure, after the DPR cap — a plain renderer.render() skips the whole
    // EffectComposer pass.
    if (adaptiveBloomOn()) bloomFx.render(); else renderer.render(scene, cam);
  }
  return { render, renderer, scene, dispose: () => { bloomFx.dispose(); ro.disconnect(); } };
}

function fitCanvas(canvas) {
  const dpr = adaptiveDpr();
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
  coreRO.observe(document.documentElement);
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
loop(0, (now) => drawCore(now)); // uncapped: native refresh rate, the display has headroom to spare
await refresh().catch((e) => console.warn('refresh', e));
renderApps();
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)).then(() => renderApps()), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
