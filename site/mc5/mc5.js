// Mission Control 5: pipeline overview. Events and service scores come from their configured feeds.
// The infrastructure panel has no feed.
import * as THREE from 'three';
import { query } from '/lib/prom.js';
import { guardRefresh } from '/lib/refresh.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  clamp, hue, esc, loadConfig, setState, loop, SCORE_OK_MIN, SCORE_DEGRADED_MIN, scorePct,
  onDispose, onContextLoss, disposeThreeScene, hardwareGL,
  adaptiveBloomOn, adaptiveDpr,
} from '/lib/stage.js';
import { groupedHexLayout } from '/lib/hexlayout.js';
import { serviceScoreState } from '/lib/serviceScoreState.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c'];

/* =============================================================================================
 * Service health uses the configured score query and draws real scores in the app grid.
 * ========================================================================================== */
const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = (cfg.groups || []).map((g, i) => ({ ...g, c: PALETTE[i % PALETTE.length] }));
// Grouped by config.groups order (first group wins for a duplicate), never alphabetical —
// hexLayout keeps the null gap markers the app grid draws as empty cells between groups.
const hexLayout = groupedHexLayout(groups);
const apps = hexLayout.filter((n) => n !== null).map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
// Grid-drawing order only (drawAppGrid): same order as `apps`, with `null` gap cells
// re-inserted — scoring/summary code below always uses `apps`/`appIndex`, never this.
const hexCells = hexLayout.map((n) => (n === null ? null : appIndex[n]));
const model = { scoreFailed: false };

async function refreshApps() {
  let rows = null;
  try { rows = await query(Q.appScore); } catch { rows = null; }
  model.scoreFailed = rows === null;
  if (rows) {
    const seen = new Set();
    for (const row of rows) {
      const a = appIndex[row.labels.name];
      if (a && Number.isFinite(row.value)) { a.s = clamp(row.value, 0, 10); seen.add(a.n); }
    }
    for (const a of apps) if (!seen.has(a.n)) a.s = null;
  }
  renderApps();
}
const guardedRefreshApps = guardRefresh(refreshApps);
function renderApps() {
  const scored = apps.filter((a) => a.s != null);
  const scores = scored.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length, warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = scores.length
    ? `<span style="color:var(--green)">${ok} OK</span> · <span style="color:var(--amber)">${warn} DEGRADED</span> · <span style="color:var(--red)">${bad} DOWN</span>`
    : '—';
  const state = serviceScoreState(model.scoreFailed, scored.length > 0);
  const message = state === 'error' || state === 'stale' ? 'SCORE QUERY FAILED'
    : state === 'empty' ? (apps.length ? 'NO SERVICE DATA' : 'NO APPS CONFIGURED')
      : scored.length < apps.length ? 'PARTIAL SERVICE DATA' : '';
  setState($('apps'), state, message);
  $('appgrid').dataset.unknownCount = String(apps.filter((a) => a.s == null).length);
  drawAppGrid();
}
function drawAppGrid() {
  const canvas = $('appgrid'), c = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  if (!hexCells.length) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(hexCells.length * W / H)));
  const rows = Math.ceil(hexCells.length / cols);
  const cw = W / cols, ch = H / rows, pad = Math.min(cw, ch) * 0.08;
  hexCells.forEach((a, i) => {
    const col = i % cols, row = (i / cols) | 0;
    if (!a) return; // gap cell between groups — reserved grid space, nothing drawn
    const x = col * cw + pad, y = row * ch + pad, w = cw - pad * 2, h = ch - pad * 2;
    const val = a.s;
    const colr = val == null ? 'hsl(220,15%,55%)' : hue(scorePct(val));
    c.fillStyle = colr.replace('55%', '18%'); c.fillRect(x, y, w, h);
    c.strokeStyle = colr; c.lineWidth = Math.max(1, ch * 0.02); c.strokeRect(x, y, w, h);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = `600 ${Math.max(9, h * 0.32)}px "Chakra Petch",sans-serif`;
    c.fillText(val == null ? '—' : String(Math.round(val)), x + w / 2, y + h * 0.48);
    c.fillStyle = '#9aa3d9'; c.font = `${Math.max(7, h * 0.16)}px "JetBrains Mono",monospace`;
    const label = a.n.length > 10 ? a.n.slice(0, 9) + '…' : a.n;
    c.fillText(label, x + w / 2, y + h * 0.78);
  });
}
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

/* =============================================================================================
 * Event and release data use conditional requests and a local cache. Failed requests keep cached
 * values available so panels can identify them as stale.
 * ========================================================================================== */
const GH_ORG = 'dryvist';
const GH_API = 'https://api.github.com';
const TAU = Math.PI * 2;

function lsGet(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable/full */ } }

async function ghGet(path, cacheKey) {
  const cached = lsGet(cacheKey);
  const headers = { Accept: 'application/vnd.github+json' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  try {
    const res = await fetch(`${GH_API}${path}`, { headers });
    if (res.status === 304 && cached) { lsSet(cacheKey, { ...cached, at: Date.now() }); return { data: cached.data, stale: false }; }
    if (!res.ok) throw new Error(`gh ${res.status}`);
    const data = await res.json();
    lsSet(cacheKey, { etag: res.headers.get('etag') || null, pollSeconds: Number(res.headers.get('x-poll-interval')) || null, data, at: Date.now() });
    return { data, stale: false };
  } catch {
    return { data: cached?.data ?? null, stale: Boolean(cached) };
  }
}
const shortName = (full) => (full || '').split('/').pop();
const relAge = (iso) => {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '—';
  const s = Math.max(0, (Date.now() - timestamp) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60; if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60; if (h < 36) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
};

// Stage mapping (STAGES below, ring order): the five pipeline stops a comet can fly to.
const STAGES = ['push', 'pr', 'merge', 'release', 'deploy'];
const STAGE_HEX = { push: 0x3ee6ff, pr: 0x7b8cff, merge: 0x38ff9c, release: 0xffb347, deploy: 0xff4fd8 };
function stageFor(evt) {
  switch (evt.type) {
    case 'PushEvent': return 'push';
    case 'PullRequestEvent': return evt.payload?.action === 'closed' && evt.payload?.pull_request?.merged ? 'merge' : 'pr';
    case 'ReleaseEvent': return 'release';
    case 'DeploymentEvent': case 'DeploymentStatusEvent': return 'deploy';
    default: return null;
  }
}
function verbFor(evt) {
  switch (evt.type) {
    case 'PushEvent': {
      const n = evt.payload?.commits?.length;
      return Number.isFinite(n) ? `pushed ${n} commit${n === 1 ? '' : 's'}` : 'pushed commits';
    }
    case 'PullRequestEvent': return evt.payload?.pull_request?.merged ? 'merged PR' : evt.payload?.action ? `${evt.payload.action} PR` : 'pull request update';
    case 'ReleaseEvent': return 'published a release';
    case 'DeploymentEvent': case 'DeploymentStatusEvent': return 'deployed';
    case 'IssuesEvent': return evt.payload?.action ? `${evt.payload.action} issue` : 'issue activity';
    case 'WatchEvent': return 'starred';
    case 'ForkEvent': return 'forked';
    case 'CreateEvent': return evt.payload?.ref_type ? `created ${evt.payload.ref_type}` : 'created reference';
    default: return evt.type?.replace(/Event$/, '').toLowerCase() || '—';
  }
}

/* -------------------------------- shared scene state -------------------------------------- */
// Both the 3D and 2D renderers read this — repo layout and comet progress computed once, drawn
// twice, never duplicated between the two renderers.
const sceneState = { repos: [], comets: [] }; // Repo activity is optional when its timestamp is missing.
function spawnComet(repoFullName, stage) {
  const key = shortName(repoFullName);
  if (!stage || !key) return;
  const repoIndex = sceneState.repos.findIndex((r) => r.name === key);
  sceneState.comets.push({ repoIndex, key, stage, start: performance.now(), dur: 1.8 + Math.random() * 0.6 });
  if (sceneState.comets.length > 60) sceneState.comets.shift();
}
function tickComets(now) { sceneState.comets = sceneState.comets.filter((c) => (now - c.start) / c.dur < 1); }
function hashAngle(str) { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000 * TAU; }
function repoAngle(repoIndex, key) {
  return repoIndex >= 0 && sceneState.repos.length ? (repoIndex / sceneState.repos.length) * TAU : hashAngle(key);
}

/* ------------------------------------ events poll -------------------------------------------*/
let tickerEvents = [];
const seenEventIds = new Set();
function applyEvents(events) {
  const fresh = events.filter((e) => !seenEventIds.has(e.id));
  for (const e of events) seenEventIds.add(e.id);
  tickerEvents = [...fresh, ...tickerEvents].slice(0, 14);
  for (const e of fresh) spawnComet(e.repo?.name, stageFor(e));
}
function renderTicker(state, message) {
  const rows = tickerEvents.map((e) => {
    const stage = stageFor(e);
    const col = stage ? `var(--stage-${stage})` : 'var(--ink)';
    const age = relAge(e.created_at);
    const ago = age === '—' ? age : `${age} ago`;
    return `<div class="feed-row"><span class="name">${esc(e.actor?.login || '—')} · ${esc(shortName(e.repo?.name) || '—')}</span><span class="status" style="color:${col}">${esc(verbFor(e))}</span><span class="ago">${esc(ago)}</span></div>`;
  }).join('');
  $('tickerBody').innerHTML = rows || '<div class="feed-row"><span class="name">—</span></div>';
  setState($('ticker'), state, message);
}
let eventsTimer = null;
async function pollEvents() {
  const result = await ghGet(`/orgs/${GH_ORG}/events`, 'mc5.gh.events');
  if (Array.isArray(result.data) && result.data.length) {
    applyEvents(result.data);
    renderTicker(result.stale ? 'stale' : 'ok', result.stale ? 'SHOWING LAST GOOD EVENTS' : '');
  } else if (Array.isArray(result.data)) {
    tickerEvents = [];
    seenEventIds.clear();
    renderTicker(result.stale ? 'error' : 'empty', result.stale ? 'EVENT QUERY FAILED' : 'NO RECENT EVENTS');
  } else if (tickerEvents.length) renderTicker('stale', 'EVENT QUERY FAILED');
  else renderTicker('error', 'EVENT QUERY FAILED');
  const cached = lsGet('mc5.gh.events');
  const delaySec = Math.max(Number(cached?.pollSeconds) || 60, 60);
  eventsTimer = setTimeout(pollEvents, delaySec * 1000);
}
onDispose(() => clearTimeout(eventsTimer));

/* ------------------------------------ repos + releases ---------------------------------------*/
let releases = [];
function renderReleases(state, message) {
  const rows = releases.map((r) => {
    const ago = r.ago === '—' ? r.ago : `${r.ago} ago`;
    return `<div class="feed-row"><span class="name">${esc(r.repo)}</span><span class="status" style="color:var(--reef)">${esc(r.tag || '—')}</span><span class="ago">${esc(ago)}</span></div>`;
  }).join('');
  $('releasesBody').innerHTML = rows || '<div class="feed-row"><span class="name">—</span></div>';
  setState($('releases'), state, message);
}
async function pollReleases(topRepos, reposStale) {
  if (!topRepos.length) {
    if (reposStale && releases.length) renderReleases('stale', 'SHOWING LAST GOOD DATA');
    else {
      releases = [];
      renderReleases(reposStale ? 'error' : 'empty', reposStale ? 'REPOSITORY QUERY FAILED' : 'NO RELEASE DATA');
    }
    return;
  }
  const found = [];
  let failed = false, releaseStale = false;
  for (const r of topRepos.slice(0, 5)) {
    const short = shortName(r.name);
    const result = await ghGet(`/repos/${GH_ORG}/${short}/releases?per_page=1`, `mc5.gh.rel.${short}`);
    releaseStale ||= result.stale;
    if (!Array.isArray(result.data)) { failed = true; continue; }
    if (result.data.length) {
      const release = result.data[0];
      found.push({ repo: short, tag: release.tag_name || '—', ago: relAge(release.published_at) });
    }
  }
  if (found.length) {
    releases = found;
    renderReleases(reposStale || releaseStale || failed ? 'stale' : 'ok', failed ? 'SOME RELEASES UNAVAILABLE' : reposStale || releaseStale ? 'SHOWING LAST GOOD DATA' : '');
  } else if (failed || releaseStale) {
    renderReleases(releases.length ? 'stale' : 'error', 'RELEASE QUERY FAILED');
  } else {
    releases = [];
    renderReleases('empty', 'NO RELEASE DATA');
  }
}
let repoLayoutHook = () => {};
let reposTimer = null;
async function pollRepos() {
  const result = await ghGet(`/orgs/${GH_ORG}/repos?per_page=100&sort=pushed&type=public`, 'mc5.gh.repos');
  if (Array.isArray(result.data)) {
    const top = result.data.filter((r) => r.private === false && typeof r.name === 'string').slice(0, 14);
    const now = Date.now();
    sceneState.repos = top.map((r) => {
      const pushedAt = Date.parse(r.pushed_at || '');
      const days = Number.isFinite(pushedAt) ? clamp((now - pushedAt) / 86400000, 0, 60) : null;
      return { name: r.name, activity: days == null ? null : clamp(1 - days / 30, 0.08, 1) };
    });
    repoLayoutHook(sceneState.repos);
    await pollReleases(top, result.stale);
  } else renderReleases(releases.length ? 'stale' : 'error', 'REPOSITORY QUERY FAILED');
  reposTimer = setTimeout(pollRepos, 3600_000);
}
onDispose(() => clearTimeout(reposTimer));

setState($('infra'), 'no-feed');

/* =============================================================================================
 * Hero: orbiting repository nodes and event comets around the pipeline-stage ring. Reuses the
 * full-viewport scene pattern: WebGLRenderer + makeBloom, a ResizeObserver on
 * document.documentElement (never the canvas's own rendered size), adaptive quality, context-loss
 * rebuild, and a 2D canvas fallback when hardwareGL() says no.
 * ========================================================================================== */
const coreCanvas = $('corecanvas');
const forced = new URLSearchParams(location.search).get('gl');
const R_STAGE = 110, R_REPO = 210;

function build3DScene() {
  const renderer = new THREE.WebGLRenderer({ canvas: coreCanvas, antialias: true, alpha: false });
  renderer.setClearColor(0x030b10, 1);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(42, 1, 1, 3000);
  cam.position.set(0, 150, 340);
  cam.lookAt(0, 0, 0);
  const bloomFx = makeBloom(renderer, scene, cam, { strength: 1.15, radius: 0.45, threshold: 0.55 });

  const group = new THREE.Group(); scene.add(group);

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(26, 1), new THREE.MeshBasicMaterial({ color: 0x4fb3a9, wireframe: true }));
  group.add(core);
  const coreGlow = new THREE.Mesh(new THREE.SphereGeometry(17, 24, 24), new THREE.MeshBasicMaterial({ color: 0x4fb3a9, transparent: true, opacity: 0.28 }));
  group.add(coreGlow);

  const stageMeshes = {};
  STAGES.forEach((stage, i) => {
    const a = (i / STAGES.length) * TAU;
    const pos = new THREE.Vector3(Math.cos(a) * R_STAGE, 0, Math.sin(a) * R_STAGE);
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(7, 0), new THREE.MeshBasicMaterial({ color: STAGE_HEX[stage] }));
    m.position.copy(pos); group.add(m);
    stageMeshes[stage] = pos;
  });
  const ringPts = Array.from({ length: 65 }, (_, i) => { const a = (i / 64) * TAU; return new THREE.Vector3(Math.cos(a) * R_STAGE, 0, Math.sin(a) * R_STAGE); });
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: 0x4fb3a9, transparent: true, opacity: 0.22 })));

  let repoMeshes = [];
  function layoutRepoNodes(repos) {
    repoMeshes.forEach((r) => { group.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); });
    repoMeshes = repos.map((r, i) => {
      const a = repoAngle(i, r.name);
      const size = r.activity == null ? 6 : clamp(3 + r.activity * 6, 3, 14);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 16), new THREE.MeshBasicMaterial({ color: 0x3f8f86, transparent: true, opacity: 0.9 }));
      mesh.position.set(Math.cos(a) * R_REPO, Math.sin(i * 1.7) * 16, Math.sin(a) * R_REPO);
      group.add(mesh);
      return { name: r.name, mesh };
    });
  }
  repoLayoutHook = layoutRepoNodes;

  const cometMeshes = new Map(); // comet object -> Mesh
  function syncComets(now) {
    tickComets(now);
    const live = new Set(sceneState.comets);
    for (const [comet, mesh] of cometMeshes) if (!live.has(comet)) { group.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); cometMeshes.delete(comet); }
    for (const c of sceneState.comets) {
      if (!cometMeshes.has(c)) {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 8), new THREE.MeshBasicMaterial({ color: STAGE_HEX[c.stage] }));
        group.add(mesh); cometMeshes.set(c, mesh);
      }
      const mesh = cometMeshes.get(c);
      const t = clamp((now - c.start) / c.dur, 0, 1);
      const a = repoAngle(c.repoIndex, c.key);
      const from = new THREE.Vector3(Math.cos(a) * R_REPO, 0, Math.sin(a) * R_REPO);
      const to = stageMeshes[c.stage];
      const p = new THREE.Vector3().lerpVectors(from, to, t);
      p.y += Math.sin(t * Math.PI) * 26;
      mesh.position.copy(p);
    }
  }

  const resizeAt = (w, h) => { renderer.setSize(w, h, false); bloomFx.setSize(w, h); cam.aspect = w / (h || 1); cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(() => { fitHero(coreCanvas); resizeAt(coreCanvas.width, coreCanvas.height); });
  ro.observe(document.documentElement);
  fitHero(coreCanvas); resizeAt(coreCanvas.width, coreCanvas.height);

  function render(now) {
    const t = RM ? 0 : now / 1000;
    if (!RM) { cam.position.x = Math.sin(t * 0.08) * 60; cam.position.y = 150 + Math.sin(t * 0.05) * 24; cam.lookAt(0, 0, 0); }
    group.rotation.y = t * 0.06;
    core.rotation.y += 0.008; core.rotation.x += 0.003;
    coreGlow.scale.setScalar(1 + Math.sin(t * 2) * 0.06);
    syncComets(performance.now());
    if (adaptiveBloomOn()) bloomFx.render(); else renderer.render(scene, cam);
  }
  return { render, renderer, scene, dispose: () => { bloomFx.dispose(); ro.disconnect(); repoMeshes.forEach((r) => { r.mesh.geometry.dispose(); r.mesh.material.dispose(); }); } };
}

function fitHero(canvas) {
  const dpr = adaptiveDpr();
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// 2D fallback (no hardware GL): concentric core/ring/repo-dot/comet-dot picture, same data model.
function build2DScene() {
  const ro = new ResizeObserver(() => fitHero(coreCanvas));
  ro.observe(document.documentElement);
  onDispose(() => ro.disconnect());
  fitHero(coreCanvas);
  repoLayoutHook = () => {}; // layout is computed per-frame from sceneState directly below
  return (now) => {
    const w = coreCanvas.width, h = coreCanvas.height;
    if (!w || !h) return;
    const c = coreCanvas.getContext('2d');
    c.fillStyle = '#030b10'; c.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, base = Math.min(w, h) * 0.32;
    tickComets(now);
    c.strokeStyle = 'rgba(79,179,169,.3)'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(cx, cy, base * (R_STAGE / R_REPO), 0, TAU); c.stroke();
    STAGES.forEach((stage, i) => {
      const a = (i / STAGES.length) * TAU;
      const x = cx + Math.cos(a) * base * (R_STAGE / R_REPO), y = cy + Math.sin(a) * base * (R_STAGE / R_REPO);
      c.fillStyle = `#${STAGE_HEX[stage].toString(16).padStart(6, '0')}`;
      c.beginPath(); c.arc(x, y, 5, 0, TAU); c.fill();
    });
    sceneState.repos.forEach((r, i) => {
      const a = repoAngle(i, r.name), x = cx + Math.cos(a) * base, y = cy + Math.sin(a) * base;
      c.fillStyle = 'rgba(63,143,134,.9)';
      c.beginPath(); c.arc(x, y, r.activity == null ? 6 : clamp(3 + r.activity * 6, 3, 12), 0, TAU); c.fill();
    });
    sceneState.comets.forEach((cm) => {
      const t = clamp((now - cm.start) / cm.dur, 0, 1);
      const a = repoAngle(cm.repoIndex, cm.key);
      const fx = cx + Math.cos(a) * base, fy = cy + Math.sin(a) * base;
      const si = STAGES.indexOf(cm.stage), sa = (si / STAGES.length) * TAU;
      const tx = cx + Math.cos(sa) * base * (R_STAGE / R_REPO), ty = cy + Math.sin(sa) * base * (R_STAGE / R_REPO);
      const x = fx + (tx - fx) * t, y = fy + (ty - fy) * t;
      c.fillStyle = `#${STAGE_HEX[cm.stage].toString(16).padStart(6, '0')}`;
      c.beginPath(); c.arc(x, y, 3, 0, TAU); c.fill();
    });
    const pulse = base * 0.22 + (RM ? 0 : Math.sin(now / 700) * base * 0.02);
    c.strokeStyle = 'rgba(79,179,169,.7)'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, pulse, 0, TAU); c.stroke();
  };
}

let drawHero;
if (forced === '3d' || (forced !== '2d' && hardwareGL())) {
  let hero3d = build3DScene();
  drawHero = (now) => hero3d.render(now);
  onContextLoss(coreCanvas, () => {
    hero3d.dispose();
    disposeThreeScene(hero3d.renderer, hero3d.scene);
    hero3d = build3DScene();
  });
  onDispose(() => { hero3d.dispose(); disposeThreeScene(hero3d.renderer, hero3d.scene); });
} else {
  drawHero = build2DScene();
}

/* ---------------------------------------- boot -------------------------------------------- */

const tickClock = () => { const d = new Date(); $('clock').innerHTML = `${d.toTimeString().slice(0, 8)}<small>${d.toDateString().toUpperCase()}</small>`; };
tickClock();
const clockId = setInterval(tickClock, 1000);
onDispose(() => clearInterval(clockId));

// The render loop starts before data fetches resolve, so a slow or failed request never delays
// the ready signal past the rotator's probe window.
loop(0, (now) => drawHero(now)); // uncapped: native refresh rate, adaptive quality steps it down
fitCanvas($('apps'), $('appgrid'), drawAppGrid);
await guardedRefreshApps().catch((e) => console.warn('refresh', e));
const appsRefreshId = setInterval(() => guardedRefreshApps().catch((e) => console.warn('refresh', e)), (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(appsRefreshId));
pollEvents();
pollRepos();
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
