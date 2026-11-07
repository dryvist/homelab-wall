// Mission Control 2: edge threat map. The edge panels have no feed; the globe is decorative.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { guardRefresh } from '/lib/refresh.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  hardwareGL, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN,
  observeCanvas, onDispose, onContextLoss, disposeThreeScene, adaptiveBloomOn,
} from '/lib/stage.js';
import { serviceScoreState } from '/lib/serviceScoreState.js';
import { createPointer } from '/lib/pointer.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const { pointer, dispose: disposePointer } = createPointer();
onDispose(disposePointer);

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const apps = [...new Set((cfg.groups || []).flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { scoreFailed: false };

/* ---------------- apps strip (real data) ---------------- */
async function refresh() {
  const r = await settle({ score: () => query(Q.appScore) });
  model.scoreFailed = r.score === null;
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
  if (!apps.length) { $('appsum').textContent = '—'; setState(panel, 'empty', 'NO APPS CONFIGURED'); return; }
  const scored = apps.filter((a) => a.s != null);
  const scores = scored.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = scores.length
    ? `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`
    : '—';
  const state = serviceScoreState(model.scoreFailed, scored.length > 0);
  const message = state === 'error' || state === 'stale' ? 'SCORE QUERY FAILED'
    : state === 'empty' ? 'NO SERVICE DATA'
      : scored.length < apps.length ? 'PARTIAL SERVICE DATA' : '';
  setState(panel, state, message);
}

setState($('threat'), 'no-feed');
setState($('blocked'), 'no-feed');

const HOME_LATLON = [40, -86];

/* ---------------- globe with a beacon ---------------- */
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
  // The canvas is a full-viewport layer (site/mc2/mc2.css #globe), so fov/distance sweep the globe across the
  // WHOLE screen (behind the header and side panels) rather than fitting inside one panel.
  const cam = new THREE.PerspectiveCamera(48, 1, 1, 1000);
  cam.position.set(0, 0, 285);
  const group = new THREE.Group();
  // Lead review (round 2): 1.3x so the globe overflows the top/bottom edges and reaches further
  // into the screen's empty left half instead of sitting small and centre-right.
  group.scale.setScalar(1.3);
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
  // Bright red, plain (no HDR multiply): land reads clearly without adding to the bloom pass.
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
  group.add(fresnelShell(80.6, new THREE.Color(1.6, 0.45, 0.6), 6, 1)); // thin crisp rim
  group.add(fresnelShell(88, new THREE.Color(0.9, 0.2, 0.35), 3.5, 0.14)); // subtle wide outer glow
  // A faint wide orbit ring, well outside the globe — fills the screen's dead space (especially
  // the empty left half) instead of leaving it flat black.
  const orbitRing = new THREE.Mesh(
    new THREE.RingGeometry(118, 119.4, 96, 1, 0, Math.PI * 2 * 0.94),
    new THREE.MeshBasicMaterial({ color: 0xff3350, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
  );
  orbitRing.rotation.x = Math.PI / 2.35;
  group.add(orbitRing);

  const llToVec = (lat, lon, h = 80) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * h, Math.sin(la) * h, -Math.cos(la) * Math.sin(lo) * h);
  };
  const home = llToVec(...HOME_LATLON);
  // The home marker and periodic ring pulse animate without representing traffic.
  const homeCoreMat = new THREE.MeshBasicMaterial({ color: 0x9beeff });
  homeCoreMat.color.multiplyScalar(2);
  const homeMarker = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 16), homeCoreMat);
  homeMarker.position.copy(home);
  group.add(homeMarker);

  // Orient the group once so HOME sits on the visible front-upper hemisphere instead of wherever
  // its raw coordinates fall. Vector math keeps the marker in frame if HOME_LATLON changes.
  const ELEV_DEG = 18; // ~35% down from the top of the globe's rendered disc
  const targetDir = new THREE.Vector3(0, Math.sin(ELEV_DEG * Math.PI / 180), Math.cos(ELEV_DEG * Math.PI / 180));
  const alignQuat = new THREE.Quaternion().setFromUnitVectors(home.clone().normalize(), targetDir);
  const wobbleAxis = new THREE.Vector3(0, 1, 0);

  const pulses = [];
  const pulseMat = () => { const m = new THREE.MeshBasicMaterial({ color: 0x9beeff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }); m.color.multiplyScalar(1.6); return m; };
  function spawnPulse() {
    // Cap concurrent rings so overlapping pulses keep the beacon crisp.
    if (pulses.length >= 6) return;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.7, 28), pulseMat());
    ring.position.copy(home);
    ring.lookAt(0, 0, 0);
    group.add(ring);
    pulses.push({ ring, t: 0 });
  }
  let beaconT = 0;

  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.25, radius: 0.4, threshold: 0.52 });
  // The canvas is a full-viewport fixed layer now (mc2.css #globe), not the "threat" panel's box —
  // size the backing store from the viewport itself (document.documentElement's ResizeObserver
  // fires on viewport resize) rather than any one panel.
  observeCanvas(document.documentElement, globeCanvas, (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); });
  const render = (now) => {
    // A gentle yaw wobble around the aligned orientation (not a full spin) — HOME stays on the
    // visible face at all times, per the alignment above, instead of orbiting away each cycle.
    const wobble = RM ? 0.08 : Math.sin(now / 9000) * 0.12;
    group.quaternion.copy(alignQuat).multiply(new THREE.Quaternion().setFromAxisAngle(wobbleAxis, wobble));
    orbitRing.rotation.z += RM ? 0 : 0.0016;
    // Slow camera drift (shock-and-awe): the globe's own orientation is pinned (HOME must stay
    // on the visible face), so the "alive, not static" motion comes from the camera instead — a
    // slow figure-eight-ish orbit around the default position, never enough to lose the globe.
    if (!RM) {
      cam.position.x = Math.sin(now / 14000) * 18 + pointer.x * 16;
      cam.position.y = Math.sin(now / 21000) * 10 + pointer.y * 9;
      cam.lookAt(0, 0, 0);
    }
    homeMarker.scale.setScalar(1 + 0.22 * Math.sin(now / 260));
    beaconT += RM ? 0.02 : 0.014;
    if (beaconT >= 1) { beaconT = 0; spawnPulse(); }
    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      const p = pulses[i];
      p.t += RM ? 0.05 : 0.032;
      const s = 1 + p.t * 10;
      p.ring.scale.set(s, s, s);
      p.ring.material.opacity = Math.max(0, 0.9 * (1 - p.t));
      if (p.t >= 1) { group.remove(p.ring); p.ring.material.dispose(); pulses.splice(i, 1); }
    }
    // Adaptive quality (site/lib/stage.js): bloom is the second thing dropped under sustained
    // frame-time pressure, after the DPR cap — a plain renderer.render() skips the whole
    // EffectComposer pass.
    if (adaptiveBloomOn()) bloomFx.render(); else renderer.render(scene, cam);
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
const guardedRefresh = guardRefresh(refresh);
await guardedRefresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(() => guardedRefresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
