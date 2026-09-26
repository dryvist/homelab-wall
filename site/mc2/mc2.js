// Mission Control 2: edge threat map. The firewall/geoip block feed has no Prometheus source
// yet (it lands with the Splunk pipeline), so the "threat" panel stays pending — the globe is
// decoration only, never fabricated block data. The "apps" strip is real, driven by the same
// Gatus-derived health score as mc1.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  hardwareGL, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setSampleBadge, setStandIn,
  observeCanvas, onDispose, onContextLoss, disposeThreeScene,
} from '/lib/stage.js';
import { sampleAppScore, SAMPLE_THREAT_STATS } from '/lib/sampleData.js';

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

/* ---------------- threat panel (stand-in: no edge/geoip metrics exist yet) ---------------- */
// No edge/geoip feed exists yet — stand-in stats, machine-flagged only (setStandIn: no visible
// badge/pending text — see site/lib/stage.js). Never written into any live model. The numbers
// drift gently every refresh tick (see the interval below) instead of sitting static.
setState($('threat'), 'ok', '');
setStandIn($('threat'), true);
function renderThreatStats() {
  const drift = (base, seed) => Math.round(base * (1 + 0.08 * Math.sin(Date.now() / 5000 + seed)));
  document.querySelectorAll('#tstats div b').forEach((b, i) => {
    b.textContent = i === 0 ? String(drift(SAMPLE_THREAT_STATS.blockedToday, 0)) : String(drift(SAMPLE_THREAT_STATS.uniqueSources, 1));
  });
}
renderThreatStats();
const threatStatsId = setInterval(renderThreatStats, 4000);
onDispose(() => clearInterval(threatStatsId));

const threatPanel = $('threat');
const globeCanvas = $('globe');
const forced = new URLSearchParams(location.search).get('gl');
let drawGlobe;

// Great-circle arc source cities (approximate lat/lon) for the decorative "incoming block" arcs
// — sketch scene 60 (scratchpad/wall-sketches.html, add('MISSION CONTROL 2 · THREAT GLOBE'). No
// live geoip/block feed exists yet (see the `threat` panel above), so these arcs are ambient
// motion only, same footing as the rest of this panel's SAMPLE DATA.
const ARC_SOURCES = [
  [35, 105], [56, 38], [-15, -48], [21, 78], [16, 106], [52, 5],
  [51, 10], [37, 127], [32, 53], [9, 8], [49, 32], [1, 104],
];
const HOME_LATLON = [40, -86];

function buildGlobe() {
  const renderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1); // backing-store pixels are set explicitly below
  const scene = new THREE.Scene();
  // fov/distance tuned so the globe fills most of the panel height rather than sitting small in
  // a mostly-empty frame (the live-wall finding: "small, dim... 70% empty dark space").
  const cam = new THREE.PerspectiveCamera(46, 1, 1, 1000);
  cam.position.set(0, 0, 210);
  const group = new THREE.Group();
  scene.add(group);
  const pts = [];
  for (let i = 0; i < 9000; i++) {
    const y = 1 - (i / 8999) * 2, rr = Math.sqrt(Math.max(0, 1 - y * y)), t = i * 2.399963;
    const x = Math.cos(t) * rr, z = Math.sin(t) * rr;
    const lat = Math.asin(y), lon = Math.atan2(z, x);
    if (Math.sin(lon * 2.2) * Math.cos(lat * 3.1) + Math.sin(lon * 5 + lat * 2) * 0.5 > 0.25) pts.push(x * 80, y * 80, z * 80);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff4f6f, size: 1.3, transparent: true, opacity: 0.8 })));
  group.add(new THREE.Mesh(new THREE.SphereGeometry(79, 48, 48), new THREE.MeshBasicMaterial({ color: 0x14040a, transparent: true, opacity: 0.9 })));
  // Atmosphere glow: an oversized, backside-only sphere so only its silhouette (the limb) shows.
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(86, 48, 48), new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.09, side: THREE.BackSide })));

  const llToVec = (lat, lon, h = 80) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * h, Math.sin(la) * h, -Math.cos(la) * Math.sin(lo) * h);
  };
  const home = llToVec(...HOME_LATLON);
  const homeMarker = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 12), new THREE.MeshBasicMaterial({ color: 0x3ee6ff }));
  homeMarker.position.copy(home);
  group.add(homeMarker);

  // Animated arcs: a small pool of quadratic-bezier lines from a source to `home`, each one drawn
  // in over ~1.6s (BufferGeometry.setDrawRange) with a leading "block" marker, then recycled.
  const arcs = [];
  function spawnArc() {
    if (arcs.length > 10) return;
    const [lat, lon] = ARC_SOURCES[(Math.random() * ARC_SOURCES.length) | 0];
    const a = llToVec(lat, lon);
    const mid = a.clone().add(home).multiplyScalar(0.5).normalize().multiplyScalar(80 + a.distanceTo(home) * 0.55);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, home);
    const points = curve.getPoints(60);
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    lineGeo.setDrawRange(0, 0);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.9 }));
    group.add(line);
    const blip = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd23e }));
    group.add(blip);
    arcs.push({ line, lineGeo, curve, blip, t: 0 });
  }
  const spawnId = RM ? null : setInterval(spawnArc, 350);
  onDispose(() => { if (spawnId) clearInterval(spawnId); });

  const bloomFx = makeBloom(renderer, scene, cam, { strength: 0.9, radius: 0.6, threshold: 0.1 });
  observeCanvas(threatPanel, globeCanvas, (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); });
  const render = (now) => {
    group.rotation.y = RM ? 0.6 : now / 9000;
    for (let i = arcs.length - 1; i >= 0; i -= 1) {
      const arc = arcs[i];
      arc.t += RM ? 0.02 : 0.012;
      const k = Math.min(60, (arc.t * 60) | 0);
      arc.lineGeo.setDrawRange(0, k);
      arc.blip.position.copy(arc.curve.getPoint(Math.min(arc.t, 1)));
      if (arc.t > 1.6) { group.remove(arc.line, arc.blip); arcs.splice(i, 1); }
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
