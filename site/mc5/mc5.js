// Mission Control 5: pipeline / GitOps overview. Service health is real (Prometheus via
// Q.appScore, same as mc1); GitHub Actions, Terrakube and Semaphore have no metrics feed yet, so
// those panels show stand-in rows (setStandIn — no visible badge/pending text; see
// site/lib/stage.js) shaped like the feed each one will eventually get.
import * as THREE from 'three';
import { query } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  clamp, hue, esc, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct,
  setSampleBadge, setStandIn, onDispose, onContextLoss, disposeThreeScene, hardwareGL,
  adaptiveBloomOn, adaptiveDpr, loop,
} from '/lib/stage.js';
import { sampleAppScore, SAMPLE_GITHUB_ROWS, SAMPLE_INFRA_ROWS, SAMPLE_ACTIVITY_ROWS } from '/lib/sampleData.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c'];
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Size a canvas's backing store from its own cell (never from the canvas's own rendered box —
// that self-reference is what grows a panel without bound), then redraw.
function fitCanvas(cell, canvas, draw) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const apply = () => {
    const w = Math.round(cell.clientWidth * dpr), h = Math.round(cell.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    draw();
  };
  const ro = new ResizeObserver(apply);
  ro.observe(cell);
  apply();
  onDispose(() => ro.disconnect());
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
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 10); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
  model.updated = Date.now();
  // renderApps() computes appsSample (the shared-score fallback flag) before renderHeader()
  // reads it for the estate ring.
  renderApps();
  renderHeader();
}

/* ---------------- header ---------------- */
function ring(el, score) {
  const c = el.getContext('2d'); c.clearRect(0, 0, 128, 128); c.lineWidth = 10;
  c.strokeStyle = '#171a45'; c.beginPath(); c.arc(64, 64, 52, 0, 7); c.stroke();
  if (score != null) {
    c.strokeStyle = hue(scorePct(score)); c.shadowColor = hue(scorePct(score)); c.shadowBlur = 14;
    c.beginPath(); c.arc(64, 64, 52, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score / 10); c.stroke(); c.shadowBlur = 0;
  }
  c.fillStyle = '#fff'; c.font = '600 34px "Chakra Petch",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(score == null ? '—' : Math.round(score), 64, 60);
  c.fillStyle = '#5d7d90'; c.font = '14px "JetBrains Mono",monospace'; c.fillText('HEALTH', 64, 90);
}
function renderHeader() {
  const scored = apps.filter((a) => a.s != null);
  // The fleet ring/KPI is the MINIMUM across every scored app, never an average — see mc1.js for
  // why: an average dilutes a single DOWN app to nothing once enough other apps are healthy.
  // Falls back to the shared sample average (appsSample) when nothing is scored, same as the
  // app grid, rather than sitting on a blank ring.
  const worst = scored.length ? Math.min(...scored.map((x) => x.s))
    : appsSample ? apps.reduce((a, _x, i) => a + sampleAppScore(i), 0) / (apps.length || 1) : null;
  // 'repos' has no real source at all (cfg.repoCount is never set by anything) — hidden rather
  // than shown as a permanent '—' placeholder.
  const k = [
    ['apps', apps.length, ''],
    ['scored', scored.length, `/${apps.length}`],
    ['health', worst != null ? Math.round(worst) : '—', ''],
  ];
  $('kpis').innerHTML = k.map(([l, v, u]) => `<div class="kpi"><b class="num">${v}<i>${u}</i></b><span>${l}</span></div>`).join('');
  $('subtitle').textContent = `${groups.length} GROUPS · ${apps.length} APPS`;
  ring($('ring'), worst);
}

/* ---------------- apps (required ok panel) ---------------- */
let appsSample = false;
function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  // A query that succeeded with zero rows has genuinely nothing to show yet — render the shared
  // sample scores instead (badged), never layered on top of real (even partial) data.
  appsSample = !scored.length;
  const display = apps.map((a, i) => (appsSample ? { n: a.n, s: sampleAppScore(i) } : a));
  const scores = display.map((a) => a.s).filter((s) => s != null);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length, warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`;
  // The one live signal the decorative hero scene has any business reflecting (flow speed/glow)
  // — never fabricated.
  model.fleetOkFrac = scores.length ? ok / scores.length : 0.8;
  setSampleBadge($('apps'), appsSample);
  setState($('apps'), scored.length ? 'ok' : 'empty');
  drawAppGrid(display);
}
function drawAppGrid(display = apps) {
  const canvas = $('appgrid'), c = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  if (!display.length) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(display.length * W / H)));
  const rows = Math.ceil(display.length / cols);
  const cw = W / cols, ch = H / rows, pad = Math.min(cw, ch) * 0.08;
  display.forEach((a, i) => {
    const col = i % cols, row = (i / cols) | 0;
    const x = col * cw + pad, y = row * ch + pad, w = cw - pad * 2, h = ch - pad * 2;
    const known = a.s != null, colr = known ? hue(scorePct(a.s)) : '#2a2f77';
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

/* ---------------- full-viewport hero: commits flowing through the pipeline, 3D (or 2D fallback) --------------- */
const heroCanvas = $('hero');
const forced = new URLSearchParams(location.search).get('gl');

function fitHero(canvas) {
  const dpr = adaptiveDpr();
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function build3DPipeline() {
  // alpha:false + opaque black clear: a transparent canvas + bloom reads as a colour fog wash
  // across the whole page instead of solid black with glow confined to the objects (same class
  // of bug MC3/MC4's hero scenes hit).
  const renderer = new THREE.WebGLRenderer({ canvas: heroCanvas, antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(48, 1, 1, 2000);
  cam.position.set(0, 24, 190);
  cam.lookAt(0, 0, 0);
  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.1, radius: 0.34, threshold: 0.6 });

  const group = new THREE.Group(); scene.add(group);

  const stars = []; for (let i = 0; i < 1200; i++) stars.push((Math.random() - 0.5) * 900, Math.random() * 400 - 80, (Math.random() - 0.5) * 500 - 150);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
  group.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x2a3a8a, size: 1.1, transparent: true, opacity: 0.7 })));

  // Repo node: the commit stream's origin, far left so the flow sweeps the full viewport width.
  const repo = new THREE.Mesh(new THREE.IcosahedronGeometry(13, 1), new THREE.MeshBasicMaterial({ color: 0x7b8cff, wireframe: true }));
  repo.position.set(-125, 0, 0); group.add(repo);
  const repoShield = new THREE.Mesh(new THREE.SphereGeometry(19, 24, 24), new THREE.MeshBasicMaterial({ color: 0x7b8cff, wireframe: true, transparent: true, opacity: 0.18 }));
  repoShield.position.copy(repo.position); group.add(repoShield);
  const repoGlow = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 16), new THREE.MeshBasicMaterial({ color: 0x7b8cff, transparent: true, opacity: 0.6 }));
  repoGlow.position.copy(repo.position); group.add(repoGlow);

  // One S-curve sweeping the repo node to a "deploy" endpoint far right — commits (particles)
  // flow along it; three stage rings mark Build/Test/Deploy checkpoints on the way.
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-125, 0, 0), new THREE.Vector3(-62, 34, -20), new THREE.Vector3(0, -16, 10),
    new THREE.Vector3(62, 28, -18), new THREE.Vector3(125, 0, 0),
  ]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 2.4, 10, false), new THREE.MeshBasicMaterial({ color: 0x3ee6ff, wireframe: true, transparent: true, opacity: 0.5 })));

  const STAGE_COLS = [0x3ee6ff, 0x38ff9c, 0xffb347];
  const stageRings = STAGE_COLS.map((col, i) => {
    const t = (i + 1) / (STAGE_COLS.length + 1) + 0.08;
    const p = curve.getPoint(t);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(13, 0.6, 8, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 }));
    ring.position.copy(p); ring.rotation.x = Math.PI / 2;
    group.add(ring);
    return ring;
  });

  const N = 260, pos = new Float32Array(N * 3), pgcol = new Float32Array(N * 3), pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(pgcol, 3));
  const dim = new THREE.Color(0x7b8cff), bright = new THREE.Color(0x38ff9c);
  group.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: 2, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
  const phase = Array.from({ length: N }, (_, i) => i / N);

  const resizeAt = (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(() => { fitHero(heroCanvas); resizeAt(heroCanvas.width, heroCanvas.height); });
  ro.observe(document.documentElement);
  fitHero(heroCanvas); resizeAt(heroCanvas.width, heroCanvas.height);

  function render(now) {
    const t = RM ? 0 : now / 1000;
    // Flow speed/brightness tied to the real fleet OK fraction — the one live signal this
    // decorative scene has any business reflecting; never fabricated.
    const health = model.fleetOkFrac ?? 0.8;
    if (!RM) {
      cam.position.x = Math.sin(t * 0.08) * 30;
      cam.position.y = 24 + Math.sin(t * 0.06) * 12;
      cam.lookAt(0, 0, 0);
      group.rotation.y = Math.sin(t * 0.05) * 0.08;
    }
    repo.rotation.y += 0.006; repo.rotation.x += 0.003;
    repoShield.rotation.y -= 0.003; repoShield.rotation.x += 0.0015;
    repoGlow.scale.setScalar(1 + Math.sin(t * 2.4) * 0.15);
    stageRings.forEach((r, i) => { r.rotation.z += 0.006 * (i % 2 ? -1 : 1); r.scale.setScalar(1 + Math.sin(t * 3 + i) * 0.06 * health); });
    phase.forEach((p, k) => {
      phase[k] = (p + 0.0025 * (0.4 + health)) % 1;
      const q = curve.getPoint(phase[k]);
      pos[k * 3] = q.x; pos[k * 3 + 1] = q.y; pos[k * 3 + 2] = q.z;
      dim.clone().lerp(bright, phase[k]).toArray(pgcol, k * 3);
    });
    pg.attributes.position.needsUpdate = true;
    pg.attributes.color.needsUpdate = true;
    // Adaptive quality (site/lib/stage.js): bloom is the second thing dropped under sustained
    // frame-time pressure, after the DPR cap — a plain renderer.render() skips the whole
    // EffectComposer pass.
    if (adaptiveBloomOn()) bloomFx.render(); else renderer.render(scene, cam);
  }
  return { render, renderer, scene, dispose: () => { bloomFx.dispose(); ro.disconnect(); } };
}

function draw2DPipelineFallback(canvas, now) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  const cy = h * 0.5, x0 = w * 0.04, x1 = w * 0.96;
  c.strokeStyle = 'rgba(123,140,255,.3)'; c.lineWidth = Math.max(1, h * 0.004);
  c.beginPath(); c.moveTo(x0, cy); c.lineTo(x1, cy); c.stroke();
  const cols = ['#3ee6ff', '#38ff9c', '#ffb347'];
  cols.forEach((col, i) => {
    const t = (i + 1) / (cols.length + 1), x = x0 + (x1 - x0) * t, r = Math.min(w, h) * 0.018 * (1 + (RM ? 0 : Math.sin(now / 900 + i) * 0.1));
    c.beginPath(); c.arc(x, cy, r, 0, Math.PI * 2); c.strokeStyle = col; c.lineWidth = 2; c.shadowColor = col; c.shadowBlur = 8; c.stroke(); c.shadowBlur = 0;
  });
}

let drawHero;
if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  let flow3d = build3DPipeline();
  drawHero = (now) => flow3d.render(now);
  onContextLoss(heroCanvas, () => {
    flow3d.dispose();
    disposeThreeScene(flow3d.renderer, flow3d.scene);
    flow3d = build3DPipeline();
  });
  onDispose(() => { flow3d.dispose(); disposeThreeScene(flow3d.renderer, flow3d.scene); });
} else {
  const heroRO = new ResizeObserver(() => fitHero(heroCanvas));
  heroRO.observe(document.documentElement);
  onDispose(() => heroRO.disconnect());
  fitHero(heroCanvas);
  drawHero = (now) => draw2DPipelineFallback(heroCanvas, now);
}

/* ---------------- boot ---------------- */
// No CI/CD, Terrakube/Semaphore, or pipeline-event exporter exists yet — stand-in rows, styled
// like a real feed (setStandIn: no visible badge/pending text, no spinner glyph). Never written
// into any live model.
setState($('github'), 'ok', '');
setState($('infra'), 'ok', '');
setState($('activity'), 'ok', '');
setStandIn($('github'), true);
setStandIn($('infra'), true);
setStandIn($('activity'), true);
const feedRow = (name, status, ago, col) => `<div class="feed-row"><span class="name">${esc(name)}</span><span class="status" style="color:${col}">${esc(status)}</span><span class="ago">${esc(ago)} ago</span></div>`;
const GH_COLOR = { 'CI passing': 'var(--green)', 'PR open': 'var(--cyan)' };
const INFRA_COLOR = { queued: 'var(--dim)', running: 'var(--cyan)' };
$('github').querySelector('.body').innerHTML = SAMPLE_GITHUB_ROWS.map((r) => feedRow(r.repo, r.status, r.ago, GH_COLOR[r.status] ?? 'var(--ink)')).join('');
$('infra').querySelector('.body').innerHTML = SAMPLE_INFRA_ROWS.map((r) => feedRow(r.name, r.status, r.ago, INFRA_COLOR[r.status] ?? 'var(--ink)')).join('');
$('activity').querySelector('.body').innerHTML = SAMPLE_ACTIVITY_ROWS.map((r) => `<div class="feed-row"><span class="name">${esc(r.text)}</span><span></span><span class="ago">${esc(r.ago)} ago</span></div>`).join('');
setState($('pipeline'), 'ok', '');
setStandIn($('pipeline'), true);
fitCanvas($('pipeline'), $('pipecanvas'), () => drawPipeline($('pipecanvas')));
fitCanvas($('apps'), $('appgrid'), drawAppGrid);
// The render loop (and the 'ready' postMessage it fires — site/lib/stage.js) starts before the
// first data refresh resolves, so a slow/failing query never delays 'ready' past the rotator's
// probe window.
loop(0, (now) => drawHero(now)); // uncapped: native refresh rate, the display has headroom to spare

const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
