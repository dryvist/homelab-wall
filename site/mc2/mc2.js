// Mission Control 2: edge threat map. The firewall/geoip block feed has no Prometheus source
// yet (it lands with the Splunk pipeline), so the "threat" panel stays pending — the globe is
// decoration only, never fabricated block data. The "apps" strip is real, driven by the same
// Gatus-derived health score as mc1.
import { query, settle } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { hardwareGL, loop, loadConfig, setState, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setSampleBadge } from '/lib/stage.js';
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
  const scores = sample ? apps.map((a, i) => sampleAppScore(i)) : scored.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  const unk = sample ? 0 : apps.length - scored.length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>${unk ? ` · <span style="color:var(--dim)">${unk} NO DATA</span>` : ''}`;
  setSampleBadge(panel, sample);
  setState(panel, scored.length ? 'ok' : 'empty', scored.length ? '' : 'NO SERVICE DATA');
}

/* ---------------- threat panel (pending: no edge/geoip metrics exist yet) ---------------- */
setState($('threat'), 'pending', 'EDGE BLOCK FEED PENDING');

// ponytail: duplicated (not imported) from the in-flight fluid rewrite of site/lib/stage.js
// (fix/mc1-layout-feedback-loop, not yet on develop) — this lane doesn't touch that file.
// Swap for the shared observeCanvas() once this branch rebases onto that PR.
function observeCanvas(cell, canvas, onResize) {
  const apply = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(cell.clientWidth * dpr), h = Math.round(cell.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; onResize?.(w, h); }
  };
  new ResizeObserver(apply).observe(cell);
  apply();
}

const threatPanel = $('threat');
const globeCanvas = $('globe');
const forced = new URLSearchParams(location.search).get('gl');
let drawGlobe;

if (window.THREE && (forced === '3d' || (forced !== '2d' && hardwareGL()))) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas: globeCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1); // backing-store pixels are set explicitly below
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 1, 1000);
  cam.position.set(0, 0, 300);
  const group = new THREE.Group();
  scene.add(group);
  const pts = [];
  for (let i = 0; i < 6000; i++) {
    const y = 1 - (i / 5999) * 2, rr = Math.sqrt(Math.max(0, 1 - y * y)), t = i * 2.399963;
    const x = Math.cos(t) * rr, z = Math.sin(t) * rr;
    const lat = Math.asin(y), lon = Math.atan2(z, x);
    if (Math.sin(lon * 2.2) * Math.cos(lat * 3.1) + Math.sin(lon * 5 + lat * 2) * 0.5 > 0.25) pts.push(x * 80, y * 80, z * 80);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff4f6f, size: 1.3, transparent: true, opacity: 0.8 })));
  group.add(new THREE.Mesh(new THREE.SphereGeometry(79, 40, 40), new THREE.MeshBasicMaterial({ color: 0x14040a, transparent: true, opacity: 0.9 })));
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(86, 40, 40), new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.07, side: THREE.BackSide })));
  observeCanvas(threatPanel, globeCanvas, (w, h) => { renderer.setSize(w, h, false); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); });
  drawGlobe = (now) => { group.rotation.y = RM ? 0.6 : now / 9000; renderer.render(scene, cam); };
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
tickClock(); setInterval(tickClock, 1000);
await refresh().catch((e) => console.warn('refresh', e));
setInterval(() => refresh().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
loop(30, (now) => drawGlobe(now));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
