// Mission Control 2: edge threat map. The firewall/geoip block feed has no Prometheus source
// yet (it lands with the Splunk pipeline), so the "threat"/"blocked" panels stay stand-in — the
// globe and feed are decoration only, never fabricated block data. The "apps" strip is real,
// driven by the same Gatus-derived health score as mc1.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  hardwareGL, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setSampleBadge, setStandIn,
  observeCanvas, onDispose, onContextLoss, disposeThreeScene,
} from '/lib/stage.js';
import { sampleAppScore } from '/lib/sampleData.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const apps = [...new Set((cfg.groups || []).flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));

/* ---------------- apps strip (real data) ---------------- */
async function refresh() {
  const r = await settle({ score: () => query(Q.appScore) });
  if (r.score) {
    const seen = new Set();
    for (const row of r.score) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = Math.max(0, Math.min(10, row.value)); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
  renderApps();
}

function renderApps() {
  const panel = $('apps');
  if (!apps.length) { setState(panel, 'empty', 'NO APPS CONFIGURED'); $('appsum').textContent = '0'; return; }
  const scored = apps.filter((a) => a.s != null);
  // A query that succeeded with zero rows has genuinely nothing to show yet — fall back to the
  // shared sample scores (badged), never on top of real (even partial) data.
  const sample = !scored.length;
  const scores = sample ? apps.map((_, i) => sampleAppScore(i)) : scored.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  const unk = sample ? 0 : apps.length - scored.length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>${unk ? ` · <span style="color:var(--dim)">${unk} NO DATA</span>` : ''}`;
  setSampleBadge(panel, sample);
  setState(panel, scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
}

/* ---------------- threat globe + blocked feed (stand-in: no edge/geoip metrics exist yet) ------
   No edge/geoip feed exists yet — every number below is a stand-in, machine-flagged only
   (setStandIn: no visible badge/pending text — see site/lib/stage.js). Never written into any
   live model. Sources for the "arcs" panel — sketch scene 60 — and the "blocked" feed panel draw
   from the same THREAT_SOURCES pool so the two panels read as one system, not two random ones. */
setState($('threat'), 'ok', '');
setStandIn($('threat'), true);
setState($('blocked'), 'ok', '');
setStandIn($('blocked'), true);

const THREAT_SOURCES = [
  { name: 'China', cc: 'CN', lat: 35, lon: 105 },
  { name: 'Russia', cc: 'RU', lat: 56, lon: 38 },
  { name: 'Brazil', cc: 'BR', lat: -15, lon: -48 },
  { name: 'India', cc: 'IN', lat: 21, lon: 78 },
  { name: 'Vietnam', cc: 'VN', lat: 16, lon: 106 },
  { name: 'Netherlands', cc: 'NL', lat: 52, lon: 5 },
  { name: 'Germany', cc: 'DE', lat: 51, lon: 10 },
  { name: 'South Korea', cc: 'KR', lat: 37, lon: 127 },
  { name: 'Iran', cc: 'IR', lat: 32, lon: 53 },
  { name: 'Nigeria', cc: 'NG', lat: 9, lon: 8 },
  { name: 'Ukraine', cc: 'UA', lat: 49, lon: 32 },
  { name: 'Singapore', cc: 'SG', lat: 1, lon: 104 },
];
const HOME_LATLON = [40, -86];
const FEED_PORTS = [22, 23, 445, 3389, 8080, 5060, 6379, 27017, 9200, 2375];
const FEED_REASONS = ['port scan', 'bad auth', 'rate limit', 'known botnet', 'invalid cert', 'exploit attempt'];

/* ---------------- blocked feed (right-third scrolling panel) ---------------- */
const feedEl = $('feed');
const MAX_FEED_ROWS = 28;
let blockedToday = 0;
const countryCounts = new Map();

function fmtTime(d) { return d.toTimeString().slice(0, 8); }

function addFeedRow(source) {
  const port = FEED_PORTS[(Math.random() * FEED_PORTS.length) | 0];
  const reason = FEED_REASONS[(Math.random() * FEED_REASONS.length) | 0];
  const row = document.createElement('div');
  row.className = 'frow';
  row.innerHTML = `<span class="t">${fmtTime(new Date())}</span>` +
    `<span class="src"><em>${source.cc}</em> ${source.name} → :${port}</span>` +
    `<span class="act drop">${reason}</span>`;
  feedEl.prepend(row);
  while (feedEl.children.length > MAX_FEED_ROWS) feedEl.lastChild.remove();

  blockedToday += 1;
  countryCounts.set(source.name, (countryCounts.get(source.name) || 0) + 1);
  renderStats();
}

function renderStats() {
  let top = 'NONE YET';
  let topN = 0;
  for (const [name, n] of countryCounts) if (n > topN) { topN = n; top = name; }
  const b = document.querySelectorAll('#tstats div b');
  b[0].textContent = String(blockedToday);
  b[1].textContent = String(countryCounts.size);
  b[2].textContent = top;
}
renderStats();

let feedId;
function scheduleFeed() {
  feedId = setTimeout(() => {
    addFeedRow(THREAT_SOURCES[(Math.random() * THREAT_SOURCES.length) | 0]);
    scheduleFeed();
  }, RM ? 4000 : 500 + Math.random() * 500);
}
scheduleFeed();
onDispose(() => clearTimeout(feedId));

/* ---------------- globe: real land mask, animated great-circle arcs ---------------- */
const threatPanel = $('threat');
const globeCanvas = $('globe');
const forced = new URLSearchParams(location.search).get('gl');
let drawGlobe;

// A real coastline-derived land mask (Natural Earth 110m land polygons, public domain, via the
// world-atlas npm package), rasterized once offline to a 240x120 (1.5deg) bit grid so the point
// cloud below reads as actual continents instead of a procedural sine-wave blob.
const LAND_MASK_COLS = 240;
const LAND_MASK_ROWS = 120;
const LAND_MASK_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAfwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPj/z////3EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/++f///w8AAPADgAEAAOADAAAAAAAAAAAAAAAg3N4f/v///wcAAB8AAAAAAAA4AAAAAAAAAAAAAAADAOAH/P///wcAAA4AAAAAAAAwAAAAAAAAAAAAAAC8cQwBAP///wcAAAAAAIAHAMD/DwDwAAAAAAAAAOAAAAAAAPz//wMAAAAAAGAAAPz/AQAAAAAAAAAAAOBdc/MDAPj//wEAAAAAABjAwP///z9gAAAAA4AAAED8A/P/AOD//////////zjg/v///z//HwAAAPj/A0/8X4PwB/D//wAAAOA/AADh/v///////wM+/P///////////////////wMAnBMgAgAAAAAAAAAAyP///////////////////wEAOAAAAQAAAAAAAAAA5////////////////////8CBBwAAAAAAAAAAAAAAAOD//////88GH8AfAAwAwJ////////////////9/APz//////wNxDIAPAAAA8M///////////////98/APzf/////wHwAwAGAAAA+M///////////////+ADAPAB+P///wHwMwAAAAAA8A//////////////ZBgAAIACgP///wPgfwAAAAAQAAf///////////8fAA4AACAAAP///z/gfwAAAAAwYMf///////////8PAB8AAAQAAP7////5/wMAAABoQOj///////////8DAA8AAAAAgPz////5/wcAAADs+P////////////9/AAcAAAAAAPj////7/wMAAADg+f////////////9/AAEAAAAAAPj/////zwAAAAAw/v////////////+/AAAAAAAAAPD/////Gw4AAACg//////////////8fAAAAAAAAAOD/////HxAAAADA//////////////8fAAAAAAAAAOD//////wAAAACA//9P/v////////8PAAAAAAAAAOD/////EwAAAACA//wH/P/////////HAAAAAAAAAOD/////AQAAAAD8g/EH8P/////////gAAAAAAAAAOD/////AAAAAAD8Aebn+f///////z8AAAAAAAAAAOD///9/AAAAAAD8AGT8/////////xpgAAAAAAAAAMD///8/AAAAAAD8AMT8////////fzggAAAAAAAAAID///8fAAAAAABwdAD8/////////zE4AAAAAAAAAID///8fAAAAAACwfwBD/////////zA/AAAAAAAAAAD+//8PAAAAAAD4fwAA/////////wAHAAAAAAAAAAD8//8DAAAAAAD8/2OA/////////4EAAAAAAAAAAADo//8DAAAAAAD8/+///////////wEAAAAAAAAAAADo/wkCAAAAAAD+//////z//////wEAAAAAAAAAAADYfwACAAAAAID///8///n//////wEAAAAAAAAAAACgfwAWAAAAAMD///9//+H//////wAAAAAAAAAAAAAgfwAAAAAAAMD///9//jPg////fwAAAAAAAAAAAAAAfgAAAAAAAOD//////H/A////PwEAAAAAAAAAAAAAfAAIAAAAAOD//////f/A/+f/BwAAAAAAAAAAAAAAfDBwAAAAAOD/////+X8A/sN/AAAAAAAAAAAAAAAA+DgAAwAAAOD/////+T8A/oB/AwAAAAAAAAAAAAAA4B8AAAAAAOD/////8x8AfoB/AAMAAAAAAAAAAAAAgPwAAAAAAOD/////8wcAPoD+AAEAAAAAAAAAAAAAAPgBAAAAAOD/////7wEAHAD+AQEAAAAAAAAAAAAAAMAAAAAAAOD/////PwAAHAD8AQQAAAAAAAAAAAAAAICAAgAAAMD/////HwMAGADgAAoAAAAAAAAAAAAAAADBfgAAAID//////wMAGABAAAAAAAAAAAAAAAAAAADy/wAAAID//////wEAIAAGAAwAAAAAAAAAAAAAAADw/wEAAAD//////wEAIAAIAAgAAAAAAAAAAAAAAADw/x8AAAD8+P///wAAAAAZYAAAAAAAAAAAAAAAAADg/z8AAAAAwP///wAAAAAbMAAAAAAAAAAAAAAAAADw/z8AAAAAwP//fwAAAAAWfAAAAAAAAAAAAAAAAAD4/38AAAAAwP//HwAAAAAcficAAAAAAAAAAAAAAAD8//8BAAAAwP//DwAAAAAYPiABAAAAAAAAAAAAAAD8//8DAAAAwP//BwAAAAA4vgEaAAAAAAAAAAAAAAD8//8/AAAAgP//BwAAAABwEBL+AAAAAAAAAAAAAAD8////AAAAAP//AwAAAABgAADwAQAAAAAAAAAAAAD8////AQAAAP//AwAAAADABADyAwEAAAAAAAAAAAD4////AQAAAP7/AwAAAAAAHADwBgQAAAAAAAAAAADw////AAAAAP7/BwAAAAAAAAQADAAAAAAAAAAAAADw//9/AAAAAP7/BwAAAAAAAAAAAAAAAAAAAAAAAADg//9/AAAAAP7/BwAAAAAAAICHAAAAAAAAAAAAAADg//8/AAAAAP//BwEAAAAAANDHAAAAAAAAAAAAAADA//8/AAAAAP//hwMAAAAAAPjHAQAAAAAAAAAAAAAA//8/AAAAAP//4QEAAAAAAPzfAQAAAAAAAAAAAAAA/v8/AAAAAP//4AEAAAAAAP7/AwAAAAAAAAAAAAAA/v8fAAAAAP5/wAAAAAAAgP//ByAAAAAAAAAAAAAA/v8fAAAAAP7/4AAAAAAA4P//D0AAAAAAAAAAAAAA/v8HAAAAAPz/4AAAAAAA8P//HwAAAAAAAAAAAAAA/v8AAAAAAPx/YAAAAAAA8P//PwAAAAAAAAAAAAAA/v8AAAAAAPw/AAAAAAAA8P//PwAAAAAAAAAAAAAA/v8AAAAAAPw/AAAAAAAA8P//PwAAAAAAAAAAAAAA/38AAAAAAPgfAAAAAAAA4P//PwAAAAAAAAAAAAAA/z8AAAAAAPAPAAAAAAAA4P//PwAAAAAAAAAAAAAA/x8AAAAAAPAHAAAAAAAA4B/+PwAAAAAAAAAAAAAA/w8AAAAAAPABAAAAAAAA4Af0HwAAAAAAAAAAAAAA/wMAAAAAAAAAAAAAAAAAAADwDwAIAAAAAAAAAACA/wMAAAAAAAAAAAAAAAAAAADgDwAQAAAAAAAAAACA/wEAAAAAAAAAAAAAAAAAAADAAgBwAAAAAAAAAACAfwAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAACAHwAAAAAAAAAAAAAAAAAAAAAABgAQAAAAAAAAAACAHwAAAAAAAAAAAAAAAAAAAAAABgAMAAAAAAAAAADADwAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAADABwAAAAAAAAAAAAAAAAAAAAAAAIADAAAAAAAAAADADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAgwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAADwAAAR4Pv4HAAAAAAAAAAAAAAAACAAAAAAAAAAA4P8/4P//////BwAAAAAAAAAAAAAAPwAAAAAAAADg//8//P///////wMAAAAAAAAAAACAewAAAADI/v////8///////////8BAAAAAAAAABAAeAAAAID///////////////////8DAAAAAAAe4P//fwAAAMD//////////////////38AAADA////////BwAAAPz//////////////////x8AAEDz//////8/AAAA8P///////////////////x8AABj///////8PAIAH/////////////////////38AAADA//////8/gPAD4P///////////////////wcAAAD+////////P4Dx/////////////////////w8AAAD8//////////////////////////////////8AAPz/AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const landMaskBytes = Uint8Array.from(atob(LAND_MASK_B64), (c) => c.charCodeAt(0));
function isLand(lat, lon) {
  const col = Math.min(LAND_MASK_COLS - 1, Math.max(0, Math.floor((lon + 180) / 360 * LAND_MASK_COLS)));
  const row = Math.min(LAND_MASK_ROWS - 1, Math.max(0, Math.floor((90 - lat) / 180 * LAND_MASK_ROWS)));
  const bit = row * LAND_MASK_COLS + col;
  return (landMaskBytes[bit >> 3] >> (bit & 7)) & 1;
}

function buildGlobe() {
  const renderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1); // backing-store pixels are set explicitly below
  const scene = new THREE.Scene();
  // fov/distance tuned so the globe fills most of the panel height rather than sitting small in
  // a mostly-empty frame (the live-wall finding: "small, dim... 70% empty dark space").
  const cam = new THREE.PerspectiveCamera(46, 1, 1, 1000);
  cam.position.set(0, 0, 196);
  const group = new THREE.Group();
  scene.add(group);

  // Land-mask point cloud: a Fibonacci sphere distribution, kept only where the real coastline
  // mask (above) says land — dense enough that continents read as continents, not a blob.
  const pts = [];
  const N = 42000;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, rr = Math.sqrt(Math.max(0, 1 - y * y)), t = i * 2.399963;
    const x = Math.cos(t) * rr, z = Math.sin(t) * rr;
    const lat = Math.asin(y) * 180 / Math.PI, lon = Math.atan2(z, x) * 180 / Math.PI;
    if (isLand(lat, lon)) pts.push(x * 80, y * 80, z * 80);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff4f6f, size: 1.15, transparent: true, opacity: 0.85 })));
  group.add(new THREE.Mesh(new THREE.SphereGeometry(79, 48, 48), new THREE.MeshBasicMaterial({ color: 0x14040a, transparent: true, opacity: 0.92 })));
  // Atmosphere rim: an oversized, backside-only sphere so only its silhouette (the limb) shows —
  // brighter and thicker than a hairline so it's visible as a distinct glow, not just AA fuzz.
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(84, 48, 48), new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.16, side: THREE.BackSide })));
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(90, 48, 48), new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.07, side: THREE.BackSide })));

  const llToVec = (lat, lon, h = 80) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * h, Math.sin(la) * h, -Math.cos(la) * Math.sin(lo) * h);
  };
  const home = llToVec(...HOME_LATLON);
  const homeMarker = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 12), new THREE.MeshBasicMaterial({ color: 0x3ee6ff }));
  homeMarker.position.copy(home);
  group.add(homeMarker);

  // Animated arcs: a pool of quadratic-bezier lines from a source to `home`. Each one draws in
  // over its lifetime (a sliding drawRange window gives a moving trail rather than a line that
  // stays fully lit once revealed), with a bright glowing head (bloom does the actual glow) and,
  // on arrival, a brief expanding "impact" ring at `home`.
  const TRAIL_LEN = 22;
  const arcs = [];
  const pulses = [];
  function spawnArc() {
    if (arcs.length >= 26) return;
    const src = THREAT_SOURCES[(Math.random() * THREAT_SOURCES.length) | 0];
    const a = llToVec(src.lat, src.lon);
    const mid = a.clone().add(home).multiplyScalar(0.5).normalize().multiplyScalar(80 + a.distanceTo(home) * 0.55);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, home);
    const points = curve.getPoints(60);
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    lineGeo.setDrawRange(0, 0);
    // Amber, not red: the globe/atmosphere are already saturated red-pink, so a same-hue line
    // washes out against it — amber (paired with the yellow head below) reads as a distinct
    // "incoming" signal instead of blending into the sphere it's crossing.
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffa63e, transparent: true, opacity: 0.95 }));
    group.add(line);
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd23e }));
    group.add(head);
    arcs.push({ line, lineGeo, curve, head, t: 0 });
  }
  const spawnId = RM ? null : setInterval(spawnArc, 260);
  onDispose(() => { if (spawnId) clearInterval(spawnId); });

  function spawnPulse() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.6, 24),
      new THREE.MeshBasicMaterial({ color: 0x3ee6ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.position.copy(home);
    ring.lookAt(0, 0, 0);
    group.add(ring);
    pulses.push({ ring, t: 0 });
  }

  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.1, radius: 0.65, threshold: 0.08 });
  observeCanvas(threatPanel, globeCanvas, (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); });
  const render = (now) => {
    group.rotation.y = RM ? 0.6 : now / 11000;
    for (let i = arcs.length - 1; i >= 0; i -= 1) {
      const arc = arcs[i];
      arc.t += RM ? 0.016 : 0.01;
      const head = Math.min(60, (arc.t * 60) | 0);
      const start = Math.max(0, head - TRAIL_LEN);
      arc.lineGeo.setDrawRange(start, head - start);
      arc.line.material.opacity = arc.t > 0.85 ? Math.max(0, 0.95 * (1 - (arc.t - 0.85) / 0.15)) : 0.95;
      arc.head.position.copy(arc.curve.getPoint(Math.min(arc.t, 1)));
      if (arc.t >= 1 && !arc.landed) { arc.landed = true; spawnPulse(); }
      if (arc.t > 1.12) { group.remove(arc.line, arc.head); arcs.splice(i, 1); }
    }
    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      const p = pulses[i];
      p.t += RM ? 0.05 : 0.035;
      const s = 1 + p.t * 9;
      p.ring.scale.set(s, s, s);
      p.ring.material.opacity = Math.max(0, 0.9 * (1 - p.t));
      if (p.t >= 1) { group.remove(p.ring); pulses.splice(i, 1); }
    }
    bloomFx.render();
  };
  return { render, renderer, scene, dispose: () => bloomFx.dispose() };
}

if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  let globe3d = buildGlobe();
  drawGlobe = (now) => globe3d.render(now);
  onContextLoss(globeCanvas, () => {
    globe3d.dispose();
    disposeThreeScene(globe3d.renderer, globe3d.scene);
    globe3d = buildGlobe();
  });
  onDispose(() => { globe3d.dispose(); disposeThreeScene(globe3d.renderer, globe3d.scene); });
} else {
  const c = globeCanvas.getContext('2d');
  observeCanvas(threatPanel, globeCanvas);
  drawGlobe = (now) => {
    const w = globeCanvas.width, h = globeCanvas.height, cx = w / 2, cy = h / 2, rad = Math.min(w, h) * 0.32;
    c.clearRect(0, 0, w, h);
    c.lineWidth = Math.max(1, w * 0.0015);
    for (let i = 0; i < 6; i++) {
      const a = RM ? 0.6 + i * 0.3 : now / 6000 + i * 0.5;
      c.strokeStyle = `rgba(255,59,92,${0.5 - i * 0.06})`;
      c.beginPath(); c.ellipse(cx, cy, rad, rad * Math.abs(Math.cos(a)), 0, 0, Math.PI * 2); c.stroke();
    }
    c.strokeStyle = 'rgba(255,45,85,.4)'; c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.stroke();
  };
}

/* ---------------- boot ---------------- */
const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));
loop(30, (now) => drawGlobe(now));
await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
