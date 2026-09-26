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
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`;
  setSampleBadge(panel, sample);
  setState(panel, scored.length ? 'ok' : 'empty');
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
  row.className = 'frow frow-flash';
  row.innerHTML = `<span class="t">${fmtTime(new Date())}</span>` +
    `<span class="src"><em>${source.cc}</em> ${source.name} → :${port}</span>` +
    `<span class="act drop">${reason}</span>`;
  feedEl.prepend(row);
  row.addEventListener('animationend', () => row.classList.remove('frow-flash'), { once: true });
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
  // alpha:false + an explicit black clear (not a transparent canvas) — see bloom.js's threshold
  // comment: a transparent canvas + low bloom threshold blooms almost every pixel into a fog wash.
  const renderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(1); // backing-store pixels are set explicitly below
  const scene = new THREE.Scene();
  // Shock-and-awe: the canvas is now a full-viewport layer (site/mc2/mc2.css #globe), not confined
  // to the old "threat" panel box, so fov/distance are tuned to sweep the globe/arcs across the
  // WHOLE screen (behind the header and side panels) rather than fitting inside one panel.
  const cam = new THREE.PerspectiveCamera(48, 1, 1, 1000);
  cam.position.set(0, 0, 285);
  const group = new THREE.Group();
  scene.add(group);

  // Land-mask point cloud: a Fibonacci sphere distribution, kept only where the real coastline
  // mask (above) says land — dense enough that continents read as continents, not a blob.
  const pts = [];
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, rr = Math.sqrt(Math.max(0, 1 - y * y)), t = i * 2.399963;
    const x = Math.cos(t) * rr, z = Math.sin(t) * rr;
    const lat = Math.asin(y) * 180 / Math.PI, lon = Math.atan2(z, x) * 180 / Math.PI;
    if (isLand(lat, lon)) pts.push(x * 80, y * 80, z * 80);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  // Bright red, plain (no HDR multiply): land should read clearly on its own without adding to
  // the bloom pass — only arc heads/the home beacon bloom (see the tube/bloom comments below).
  group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff3350, size: 1.15, transparent: true, opacity: 0.85 })));
  // Ocean/globe body: near-black, not the muddy red wash a flat BackSide "atmosphere" sphere
  // produces (that renders as a uniform-opacity disc over the WHOLE visible hemisphere, not just
  // the limb, since a plain material has no view-angle falloff) — see the fresnel rim below instead.
  group.add(new THREE.Mesh(new THREE.SphereGeometry(79, 48, 48), new THREE.MeshBasicMaterial({ color: 0x020103, transparent: true, opacity: 0.97 })));

  // Rim: a fresnel/rim shader (opacity ramps up only near the silhouette, via
  // 1-dot(normal,viewDir)) instead of a flat translucent sphere, so it reads as a thin bright
  // line at the limb rather than a wash over the whole disc. A second, larger, much softer shell
  // gives a subtle outer glow beyond that crisp line, kept separate so the rim itself stays thin.
  function fresnelShell(radius, color, power, opacity) {
    return new THREE.Mesh(
      new THREE.SphereGeometry(radius, 48, 48),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: color }, uOpacity: { value: opacity } },
        vertexShader: `varying vec3 vNormal; varying vec3 vViewDir;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vViewDir = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `varying vec3 vNormal; varying vec3 vViewDir; uniform vec3 uColor; uniform float uOpacity;
          void main() {
            float rim = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), ${power.toFixed(1)});
            gl_FragColor = vec4(uColor, rim * uOpacity);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
      }),
    );
  }
  scene.add(fresnelShell(80.6, new THREE.Color(1.6, 0.45, 0.6), 6, 1)); // thin crisp rim
  scene.add(fresnelShell(88, new THREE.Color(0.9, 0.2, 0.35), 3.5, 0.14)); // subtle wide outer glow

  const llToVec = (lat, lon, h = 80) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * h, Math.sin(la) * h, -Math.cos(la) * Math.sin(lo) * h);
  };
  const home = llToVec(...HOME_LATLON);
  // HOME beacon: an HDR-bright core (bloom does the glow) that pulses in scale every frame, plus
  // a periodic expanding ring (the same visual the impact pulse below uses on arc arrival) so the
  // beacon is visibly "alive" even between arrivals.
  const homeCoreMat = new THREE.MeshBasicMaterial({ color: 0x9beeff });
  homeCoreMat.color.multiplyScalar(2);
  const homeMarker = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 16), homeCoreMat);
  homeMarker.position.copy(home);
  group.add(homeMarker);

  // Orient the group once so HOME sits on the visible front-upper hemisphere (~35% down from the
  // globe's top edge) instead of wherever its raw lat/lon happens to fall — every arc and its
  // impact then lands in frame, never off-globe or behind it. Solved via vector math (not
  // hand-derived constants) so it stays correct if HOME_LATLON ever changes.
  const ELEV_DEG = 18; // ~35% down from the top of the globe's rendered disc
  const targetDir = new THREE.Vector3(0, Math.sin(ELEV_DEG * Math.PI / 180), Math.cos(ELEV_DEG * Math.PI / 180));
  const alignQuat = new THREE.Quaternion().setFromUnitVectors(home.clone().normalize(), targetDir);
  const wobbleAxis = new THREE.Vector3(0, 1, 0);

  // Animated arcs: a pool of tube geometries (real 3D thickness — WebGL ignores Line.linewidth
  // on every browser but Firefox-on-Windows, so a THREE.Line here would render as a 1px hairline
  // regardless of material settings) from a source to `home`, rising well above the surface.
  // Each draws in via a sliding-window index range (a moving trail, not a line that stays fully
  // lit once revealed), with an HDR glowing head and, on arrival, an expanding impact ring.
  const TUBULAR_SEGS = 48, RADIAL_SEGS = 6, IDX_PER_SEG = RADIAL_SEGS * 6, TRAIL_SEGS = 16;
  const arcs = [];
  const pulses = [];
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2cf });
  headMat.color.multiplyScalar(2.3);
  // Plain (no HDR multiply) tube color: only the head should bloom — an HDR tube across 20
  // concurrent arcs is enough bloom-eligible surface area to fog the whole panel.
  const tubeMat = () => new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 1 });
  function spawnArc() {
    if (arcs.length >= 30) return;
    const src = THREAT_SOURCES[(Math.random() * THREAT_SOURCES.length) | 0];
    const a = llToVec(src.lat, src.lon);
    // Apex fixed to 0.25-0.4 globe radii above the surface (never scaled by source distance, so
    // it can never blow past the panel edge regardless of how far around the globe a source is).
    const apexR = 80 * (1.25 + Math.random() * 0.15);
    const mid = a.clone().add(home).multiplyScalar(0.5).normalize().multiplyScalar(apexR);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, home);
    const tubeGeo = new THREE.TubeGeometry(curve, TUBULAR_SEGS, 0.65, RADIAL_SEGS, false);
    tubeGeo.setDrawRange(0, 0);
    const tube = new THREE.Mesh(tubeGeo, tubeMat());
    group.add(tube);
    const head = new THREE.Mesh(new THREE.SphereGeometry(2.1, 10, 10), headMat);
    group.add(head);
    arcs.push({ tube, tubeGeo, curve, head, t: 0 });
  }
  const spawnId = RM ? null : setInterval(spawnArc, 300);
  onDispose(() => { if (spawnId) clearInterval(spawnId); });

  const pulseMat = () => { const m = new THREE.MeshBasicMaterial({ color: 0x9beeff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }); m.color.multiplyScalar(1.6); return m; };
  function spawnPulse() {
    // Cap concurrent pulses: several overlapping additive-blended rings at the same point stack
    // into a blown-out white blob instead of reading as a beacon — a hard cap keeps HOME a crisp
    // pulsing point no matter how many arcs land close together.
    if (pulses.length >= 3) return;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.7, 28), pulseMat());
    ring.position.copy(home);
    ring.lookAt(0, 0, 0);
    group.add(ring);
    pulses.push({ ring, t: 0 });
  }
  let beaconT = 0;

  const bloomFx = makeBloom(renderer, scene, cam, { strength: 0.9, radius: 0.32, threshold: 0.65 });
  // The canvas is a full-viewport fixed layer now (mc2.css #globe), not the "threat" panel's box —
  // size the backing store from the viewport itself (document.documentElement's ResizeObserver
  // fires on viewport resize) rather than any one panel.
  observeCanvas(document.documentElement, globeCanvas, (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); });
  const render = (now) => {
    // A gentle yaw wobble around the aligned orientation (not a full spin) — HOME stays on the
    // visible face at all times, per the alignment above, instead of orbiting away each cycle.
    const wobble = RM ? 0.08 : Math.sin(now / 9000) * 0.12;
    group.quaternion.copy(alignQuat).multiply(new THREE.Quaternion().setFromAxisAngle(wobbleAxis, wobble));
    // Slow camera drift (shock-and-awe): the globe's own orientation is pinned (HOME must stay
    // on the visible face), so the "alive, not static" motion comes from the camera instead — a
    // slow figure-eight-ish orbit around the default position, never enough to lose the globe.
    if (!RM) {
      cam.position.x = Math.sin(now / 14000) * 34;
      cam.position.y = Math.sin(now / 21000) * 20;
      cam.lookAt(0, 0, 0);
    }
    homeMarker.scale.setScalar(1 + 0.22 * Math.sin(now / 260));
    beaconT += RM ? 0.02 : 0.014;
    if (beaconT >= 1) { beaconT = 0; spawnPulse(); }
    for (let i = arcs.length - 1; i >= 0; i -= 1) {
      const arc = arcs[i];
      arc.t += RM ? 0.014 : 0.009;
      const headSeg = Math.min(TUBULAR_SEGS, (arc.t * TUBULAR_SEGS) | 0);
      const startSeg = Math.max(0, headSeg - TRAIL_SEGS);
      arc.tubeGeo.setDrawRange(startSeg * IDX_PER_SEG, (headSeg - startSeg) * IDX_PER_SEG);
      arc.tube.material.opacity = arc.t > 0.85 ? Math.max(0, 1 - (arc.t - 0.85) / 0.15) : 1;
      arc.head.position.copy(arc.curve.getPoint(Math.min(arc.t, 1)));
      if (arc.t >= 1 && !arc.landed) { arc.landed = true; spawnPulse(); }
      if (arc.t > 1.12) { group.remove(arc.tube, arc.head); arc.tubeGeo.dispose(); arc.tube.material.dispose(); arcs.splice(i, 1); }
    }
    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      const p = pulses[i];
      p.t += RM ? 0.05 : 0.032;
      const s = 1 + p.t * 10;
      p.ring.scale.set(s, s, s);
      p.ring.material.opacity = Math.max(0, 0.9 * (1 - p.t));
      if (p.t >= 1) { group.remove(p.ring); p.ring.material.dispose(); pulses.splice(i, 1); }
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
  observeCanvas(document.documentElement, globeCanvas);
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
loop(0, (now) => drawGlobe(now)); // uncapped: native refresh rate, the display has headroom to spare
await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
