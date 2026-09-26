// Mission Control 3: AI inference core, driven by live litellm_router + Gatus data.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  clamp, hue, esc, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct,
  setSampleBadge, onDispose, onContextLoss, disposeThreeScene, hardwareGL, adaptiveBloomOn, adaptiveDpr,
} from '/lib/stage.js';
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
  core3d?.sync(model.models);
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
// Queue depth and p50 latency have no litellm metric exposed at all yet (see Q, site/lib/queries.js)
// — unlike tok/s and UP/DOWN, which are real once the router feed answers, these two columns are
// always stand-in. Deterministic per-model (name hash + tok rate), not random, so the dense
// readout doesn't jitter between polls; setStandIn on .modeltab (below) flags the whole row.
function hashN(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function standInQueueLatency(m) {
  if (!m.up) return { queue: 0, p50: null };
  const base = hashN(m.n) % 7;
  return { queue: base + Math.round(m.tok / 15), p50: 80 + base * 35 + Math.round(m.tok * 1.5) };
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
  $('modeltab').innerHTML = list.map((m) => {
    const col = m.up ? (m.tok > 0.05 ? 'var(--green)' : 'var(--cyan)') : 'var(--red)';
    const status = m.up ? 'tok/s' : 'health check failing';
    const { queue, p50 } = standInQueueLatency(m);
    return `<div class="mc"><div class="mch"><b title="${esc(m.n)}">${esc(m.n.split('/').pop())}</b><span style="color:${col}">${m.up ? 'UP' : 'DOWN'}</span></div>
      <div class="mctok" style="color:${col}">${m.up ? m.tok.toFixed(0) : '0'}<i>${status}</i></div>
      <canvas class="mcspark" data-model="${esc(m.n)}"></canvas>
      <div class="mcbar"><div style="width:${m.up ? clamp(m.tok * 2, 6, 100) : 100}%;background:${col}"></div></div>
      <div class="mcstats" data-source="stand-in">queue <b>${queue}</b> &middot; p50 <b>${p50 == null ? 'offline' : `${p50}ms`}</b></div></div>`;
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
// No GPU/VRAM exporter and no per-request feed exist yet (see Q, site/lib/queries.js) — these two
// widgets are always stand-in, deterministically driven off the real model list so they still
// track UP/DOWN and load instead of sitting frozen. cxReqMin mirrors the real header KPI and
// carries no [data-source] marker of its own.
let feedTimer = null;
onDispose(() => { if (feedTimer) clearTimeout(feedTimer); });
function renderCoreExtra(list) {
  $('cxReqMin').textContent = model.reqPerMin != null ? model.reqPerMin.toFixed(0) : '0';

  const upList = list.filter((m) => m.up);
  const gpuPct = clamp(Math.round((upList.reduce((s, m) => s + m.tok, 0) / Math.max(1, list.length)) * 2 + upList.length * 8), 4, 97);
  $('cxGpu').textContent = `${gpuPct}%`;
  $('cxGpu').dataset.source = 'stand-in';
  const gauge = $('gpuGauge'), gc = gauge.getContext('2d');
  const dpr = adaptiveDpr();
  const gw = Math.max(1, Math.round(gauge.clientWidth * dpr)), gh = Math.max(1, Math.round(gauge.clientHeight * dpr));
  if (gauge.width !== gw) gauge.width = gw;
  if (gauge.height !== gh) gauge.height = gh;
  gc.clearRect(0, 0, gw, gh);
  gc.fillStyle = '#200a28'; gc.fillRect(0, 0, gw, gh);
  gc.fillStyle = hue(gpuPct); gc.fillRect(0, 0, gw * gpuPct / 100, gh);
  gauge.dataset.source = 'stand-in';

  $('modelSparks').innerHTML = list.map((m) => `<div class="spk"><canvas class="spkc" data-model="${esc(m.n)}"></canvas><b>${esc(m.n.split('/').pop())}</b></div>`).join('');
  for (const canvas of $('modelSparks').querySelectorAll('.spkc')) {
    const m = list.find((x) => x.n === canvas.dataset.model);
    drawSpark(canvas, tokHistory.get(m.n) || [0], m.up ? '#3ee6ff' : '#ff3b5c');
  }

  // Stand-in recent-request feed: one row per tick from a randomly-picked UP model, cadence
  // scaled by how many models are actually serving traffic. Never scheduled twice (feedTimer
  // guards against overlapping timers across refresh ticks, the same pattern MC2's blocked-feed
  // scheduler uses).
  if (!feedTimer) scheduleFeedTick(list);
}
function scheduleFeedTick(list) {
  const upList = list.filter((m) => m.up);
  const delay = RM ? 4000 : upList.length ? 900 / upList.length : 2500;
  feedTimer = setTimeout(() => {
    feedTimer = null;
    if (upList.length) {
      const m = upList[Math.floor(Math.random() * upList.length)];
      const tokens = Math.max(1, Math.round(40 + Math.random() * 400));
      const ms = Math.max(20, Math.round(60 + Math.random() * 900));
      const row = document.createElement('div');
      row.className = 'cfrow cfrow-in';
      row.dataset.source = 'stand-in';
      row.innerHTML = `<span>${esc(m.n.split('/').pop())}</span><b>${tokens} tok</b><b>${ms}ms</b>`;
      const feed = $('reqfeed');
      feed.prepend(row);
      while (feed.children.length > 24) feed.lastElementChild.remove();
    }
    scheduleFeedTick(model.models.length ? model.models : SAMPLE_LLM.map((s) => ({ n: s.n, up: s.state < 2, tok: s.tok })));
  }, delay);
}

/* ---------------- reactor: 3D hero (sketch scene 88) or 2D fallback ---------------- */
const reactor = $('reactor');
function fitCanvas(cv) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}

// Three spinning "model core" groups (nested tori + a per-model hero geometry + orbiting
// particles + a glow column whose height tracks load) — one per served model, ported from
// scratchpad/wall-sketches.html scene 88. Capped at 3 (the sketch's layout is 3 columns); with
// fewer real models the remaining columns just show as idle/dim, never fabricated ones. Each
// core gets a distinct primary geometry (not just colour) so the three read as separate hero
// objects; a central hub ties them together with a particle stream flowing hub-ward from each.
const CORE_COLS = 3;
const CORE_GEOMETRIES = [
  () => new THREE.IcosahedronGeometry(7, 1),
  () => new THREE.TorusKnotGeometry(5, 1.6, 128, 12),
  () => new THREE.OctahedronGeometry(8, 2),
];
function build3DCore() {
  // alpha:false + an opaque black clear colour, not a transparent canvas over the panel's CSS
  // background: UnrealBloomPass blurs bright pixels outward, and over a transparent backdrop
  // that blur composited with the panel's own background as a visible teal/grey fog wash edge
  // to edge. An opaque black backbuffer keeps the glow confined to the objects themselves.
  const renderer = new THREE.WebGLRenderer({ canvas: reactor, antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
  const scene = new THREE.Scene();
  // Shock-and-awe: the canvas is now a full-viewport layer (mc3.css #reactor), not confined to
  // the old "cores" panel box, so distance/spacing are tuned to sweep the cores/hub/particle
  // streams across the WHOLE screen (behind the header and side panel) rather than one panel.
  const cam = new THREE.PerspectiveCamera(46, 1, 1, 2000);
  cam.position.set(0, 30, 260);
  // threshold 0.1 + radius 0.55 bloomed nearly every lit pixel in the scene, not just the bright
  // cores/hub — that wide, low-threshold blur is what read as a teal/grey fog wash across the
  // whole canvas instead of solid black. A much higher threshold (only genuinely HDR pixels
  // bloom) and a tighter radius confine the glow to the objects themselves.
  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.1, radius: 0.32, threshold: 0.65 });

  const spacing = 98;
  const cores = Array.from({ length: CORE_COLS }, (_, i) => {
    const g = new THREE.Group();
    g.position.x = (i - (CORE_COLS - 1) / 2) * spacing;
    scene.add(g);
    const col = new THREE.Color(PALETTE[i % PALETTE.length]);
    const rings = Array.from({ length: 7 }, (_, r) => {
      const t = new THREE.Mesh(new THREE.TorusGeometry(12 + r * 4, 0.35, 8, 64), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 - r * 0.1 }));
      t.rotation.x = Math.PI / 2 + r * 0.25; t.rotation.y = r * 0.4;
      g.add(t);
      return t;
    });
    const core = new THREE.Mesh(CORE_GEOMETRIES[i % CORE_GEOMETRIES.length](), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }));
    g.add(core);
    const N = 320, pos = new Float32Array(N * 3), pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: col, size: 1.4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    const ph = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, r: 14 + Math.random() * 26, y: (Math.random() - 0.5) * 18, s: 0.4 + Math.random() }));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending }));
    glow.position.y = -26; g.add(glow);
    return { g, rings, core, pos, pg, ph, glow, col, util: 0, name: '', up: false };
  });

  // Central hub: a small bright icosahedron every core streams tokens toward, HDR-multiplied so
  // it bloom-blooms as the scene's focal point without a fourth, redundant hero shape. Pulled
  // toward the camera (+z) and down (-y), off the middle core's own (0,0,0) position — sitting
  // on top of it would hide both the hub and the middle core's own particle stream entirely.
  const hubPos = new THREE.Vector3(0, -34, 46);
  const hub = new THREE.Mesh(new THREE.IcosahedronGeometry(4, 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 1.3, 1.6), wireframe: true }));
  hub.position.copy(hubPos);
  scene.add(hub);
  const hubGlow = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.1, 1.1, 1.4), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
  hubGlow.position.copy(hubPos);
  scene.add(hubGlow);

  // One particle stream per core: STREAM_N points recycle along the straight line from that
  // core's centre to the hub, spawning at a random phase so the flow reads continuous rather
  // than as a single pulse. Speed scales with the core's utilisation (busier model = faster flow).
  // Per-vertex colour (not a flat material colour) tapers brighter toward the hub end — a static
  // screenshot still reads flow direction (dim at the core, bright arriving at the hub), not just
  // motion over time.
  const STREAM_N = 200;
  const streams = cores.map((c) => {
    const pos = new Float32Array(STREAM_N * 3), pgcol = new Float32Array(STREAM_N * 3), pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(pgcol, 3));
    const mat = new THREE.PointsMaterial({ size: 2.4, transparent: true, opacity: 0.9, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(pg, mat);
    scene.add(pts);
    const phase = Array.from({ length: STREAM_N }, () => Math.random());
    const dim = new THREE.Color(c.col).multiplyScalar(0.5), bright = new THREE.Color(c.col).multiplyScalar(2.2);
    return { pos, pgcol, pg, phase, mat, dim, bright };
  });

  const resizeAt = (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(() => { fitCanvas(reactor); resizeAt(reactor.width, reactor.height); });
  ro.observe(reactor.parentElement);
  fitCanvas(reactor); resizeAt(reactor.width, reactor.height);

  function sync(list) {
    cores.forEach((c, i) => {
      const m = list[i];
      c.name = m?.n?.split('/').pop() ?? '';
      c.up = !!m?.up;
      c.util = m ? clamp((m.tok || 0) * 3 + (m.up ? 25 : 0), 5, 99) : 0;
    });
  }
  function render(now) {
    const t = RM ? 0 : now / 1000;
    cam.position.x = Math.sin(t * 0.12) * 40;
    cam.position.y = 30 + Math.sin(t * 0.08) * 14;
    cam.lookAt(0, 4, 0);
    hub.rotation.y += 0.006; hub.rotation.x += 0.003;
    hubGlow.scale.setScalar(1 + Math.sin(t * 1.8) * 0.12);
    cores.forEach((c, i) => {
      const sp = 0.004 + c.util / 4000;
      c.rings.forEach((rg, i2) => { rg.rotation.z += sp * (i2 % 2 ? -1 : 1) * (1 + i2 * 0.2); });
      c.core.rotation.y += sp * 3; c.core.rotation.x += sp;
      c.ph.forEach((p, k) => {
        p.a += sp * p.s * 3;
        c.pos[k * 3] = Math.cos(p.a) * p.r;
        c.pos[k * 3 + 1] = p.y + Math.sin(t * 2 + k) * 1.5;
        c.pos[k * 3 + 2] = Math.sin(p.a) * p.r;
      });
      c.pg.attributes.position.needsUpdate = true;
      const targetH = c.up ? c.util * 0.5 : 2;
      c.glow.scale.y += (targetH - c.glow.scale.y) * 0.05;
      c.glow.position.y = -26 + c.glow.scale.y / 2;
      c.glow.material.opacity = c.up ? 0.35 : 0.08;

      // Idle/down cores stream nothing (no fabricated traffic toward the hub).
      const stream = streams[i];
      const speed = c.up ? 0.15 + c.util / 220 : 0;
      const from = c.g.position, to = hub.position;
      stream.phase.forEach((ph0, k) => {
        const ph = c.up ? (ph0 + t * speed) % 1 : ph0;
        stream.pos[k * 3] = from.x + (to.x - from.x) * ph;
        stream.pos[k * 3 + 1] = from.y + (to.y - from.y) * ph + Math.sin(ph * Math.PI) * 6;
        stream.pos[k * 3 + 2] = from.z + (to.z - from.z) * ph;
        // Colour ramps dim->bright with ph (0 at the core, 1 at the hub) so the flow direction
        // reads from a single still frame, not just from motion between frames.
        stream.dim.clone().lerp(stream.bright, ph).toArray(stream.pgcol, k * 3);
      });
      stream.pg.attributes.position.needsUpdate = true;
      stream.pg.attributes.color.needsUpdate = true;
      stream.mat.opacity = c.up ? 0.9 : 0.06;
    });
    // Adaptive quality (site/lib/stage.js): bloom is the second thing dropped under sustained
    // frame-time pressure, after the DPR cap — a plain renderer.render() skips the whole
    // EffectComposer pass.
    if (adaptiveBloomOn()) bloomFx.render(); else renderer.render(scene, cam);
  }
  return { render, sync, renderer, scene, ro, dispose: () => { bloomFx.dispose(); ro.disconnect(); } };
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
const forced = new URLSearchParams(location.search).get('gl');
let core3d = null;
let drawScene = drawReactor;
if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  core3d = build3DCore();
  drawScene = (now) => core3d.render(now);
  onContextLoss(reactor, () => {
    core3d.dispose();
    disposeThreeScene(core3d.renderer, core3d.scene);
    core3d = build3DCore();
    core3d.sync(model.models);
  });
  onDispose(() => { core3d.dispose(); disposeThreeScene(core3d.renderer, core3d.scene); });
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
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
