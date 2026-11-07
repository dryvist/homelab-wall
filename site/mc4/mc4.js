// Mission Control 4: media acquisition.
import * as THREE from 'three';
import { query, settle } from '/lib/prom.js';
import { guardRefresh } from '/lib/refresh.js';
import { Q } from '/lib/queries.js';
import { makeBloom } from '/lib/bloom.js';
import {
  clamp, esc, loadConfig, setState, loop, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setSampleBadge,
  onDispose, onContextLoss, disposeThreeScene, hardwareGL, adaptiveBloomOn, adaptiveDpr,
} from '/lib/stage.js';
import { sampleAppScore } from '/lib/sampleData.js';
import { serviceScoreState } from '/lib/serviceScoreState.js';
import { createPointer } from '/lib/pointer.js';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const { pointer, dispose: disposePointer } = createPointer();
onDispose(disposePointer);

const cfg = await loadConfig();
$('title').textContent = cfg.title || 'HOMELAB';
const groups = cfg.groups || [];
const apps = [...new Set(groups.flatMap((g) => g.apps))].sort().map((n) => ({ n, s: null }));
const appIndex = Object.fromEntries(apps.map((a) => [a.n, a]));
const model = { fleetUpFrac: null, scoreFailed: false }; // drives the hero scene's brightness/motion (real signal)

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
  const state = serviceScoreState(model.scoreFailed, scored.length > 0);
  setState($('apps'), state, state === 'error' ? 'SCORE QUERY FAILED' : state === 'empty' ? 'NO SERVICE DATA' : '');
  model.fleetUpFrac = scores.length ? ok / scores.length : null;
}

/* ---------------- live media feeds ---------------- */
const panelCache = {};
const ARR_SERVICES = ['sonarr', 'radarr', 'prowlarr', 'seerr', 'qbittorrent', 'plex'];
const BYTES_PER_MIB = 1024 ** 2;
const BYTES_PER_TIB = 1024 ** 4;
const CARD_STATE_LABEL = { stale: 'STALE', error: 'ERROR', empty: 'NO DATA' };

function retainPanel(name, current) {
  const values = panelCache[name] || (panelCache[name] = {});
  const failed = new Set();
  let held = false;
  for (const [key, rows] of Object.entries(current)) {
    if (rows === null) {
      failed.add(key);
      if (values[key]?.length) held = true;
    } else values[key] = rows;
  }
  const hasValues = Object.values(values).some((rows) => rows?.length);
  const state = failed.size ? (held ? 'stale' : 'error') : hasValues ? 'ok' : 'empty';
  return { values, failed, state };
}

function updateCard(id, title, state, body) {
  const panel = $(id);
  const stateLabel = CARD_STATE_LABEL[state];
  panel.innerHTML = `<div class="ct">${esc(title)}${stateLabel ? `<small class="state-label">${stateLabel}</small>` : ''}</div>${body}`;
  setState(panel, state);
}

const metricValue = (panel, key, format, rows = panel.values[key]) => {
  if (rows?.length) {
    const row = rows.find(({ value }) => Number.isFinite(value));
    if (row) return format(row.value);
  }
  return panel.failed.has(key) ? 'ERROR' : 'NO DATA';
};
const mibRate = (value) => `${(value / BYTES_PER_MIB).toFixed(1)} MiB/s`;
const integer = (value) => Math.round(value).toLocaleString();

function renderQbit(panel) {
  const progress = panel.values.torrentProgress || [];
  const downloading = progress.filter((row) => row.labels.state === 'downloading').length;
  const seeding = progress.filter((row) => row.labels.state === 'seeding').length;
  const shares = panel.values.torrentShareRatio || [];
  const averageShare = shares.length ? shares.reduce((total, row) => total + row.value, 0) / shares.length : null;
  const connections = panel.values.qbitConnection || [];
  const connected = connections.find((row) => row.labels.status?.toLowerCase() === 'connected');
  const activeStatus = connections.find((row) => row.value > 0);
  const connection = connected
    ? connected.value > 0 ? 'CONNECTED' : 'DISCONNECTED'
    : activeStatus?.labels.status?.toUpperCase() || 'NO DATA';
  const connectionColor = connection === 'CONNECTED' ? 'green' : ['ERROR', 'NO DATA'].includes(connection) ? '' : 'red';
  const count = progress.length
    ? `${downloading} / ${seeding}`
    : panel.failed.has('torrentProgress') ? 'ERROR' : 'NO DATA';
  const ratio = shares.length
    ? averageShare.toFixed(2)
    : panel.failed.has('torrentShareRatio') ? 'ERROR' : 'NO DATA';
  const rows = [
    [metricValue(panel, 'qbitDownload', mibRate), 'download rate', 'green'],
    [metricValue(panel, 'qbitUpload', mibRate), 'upload rate', 'cyan'],
    [count, 'downloading / seeding'],
    [ratio, 'average share ratio', 'amber'],
    [metricValue(panel, 'qbitDht', integer), 'DHT nodes'],
    [panel.failed.has('qbitConnection') && !connections.length ? 'ERROR' : connection, 'connection status', connectionColor],
  ];
  const content = `<div class="qgrid">${rows.map(([value, label, color]) => `<div><b class="num${color ? ` ${color}` : ''}">${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div>`;
  updateCard('qbit', 'QBITTORRENT', panel.state, content);
}

function torrentRows(panel) {
  const torrents = new Map();
  const keyFor = (row) => JSON.stringify([row.labels.name, row.labels.state, row.labels.category]);
  const add = (row, field) => {
    if (!row.labels.name) return;
    const key = keyFor(row);
    const item = torrents.get(key) || { name: row.labels.name, state: row.labels.state, progress: null, download: null, upload: null };
    item[field] = row.value;
    torrents.set(key, item);
  };
  (panel.values.torrentProgress || []).forEach((row) => add(row, 'progress'));
  (panel.values.torrentDownload || []).forEach((row) => add(row, 'download'));
  (panel.values.torrentUpload || []).forEach((row) => add(row, 'upload'));
  return [...torrents.values()].sort((a, b) => ((b.download || 0) + (b.upload || 0)) - ((a.download || 0) + (a.upload || 0)));
}

function renderTorrents(panel) {
  const torrents = torrentRows(panel);
  const rows = torrents.slice(0, 5).map((torrent) => {
    const rate = [torrent.download, torrent.upload].filter(Number.isFinite).reduce((total, value) => total + value, 0);
    const rateText = Number.isFinite(torrent.download) || Number.isFinite(torrent.upload)
      ? mibRate(rate) : panel.failed.has('torrentDownload') || panel.failed.has('torrentUpload') ? 'ERROR' : 'NO DATA';
    const hasProgress = Number.isFinite(torrent.progress);
    const progress = hasProgress ? clamp(torrent.progress * 100, 0, 100) : null;
    const color = torrent.state === 'seeding' ? 'var(--cyan)' : 'var(--green)';
    const progressText = hasProgress ? `${Math.round(progress)}%` : 'NO PROGRESS';
    const bar = hasProgress ? `<div class="tbar"><i style="width:${progress.toFixed(0)}%;background:${color}"></i></div>` : '';
    return `<div class="trow"><span class="tn" title="${esc(torrent.name)}">${torrent.state === 'seeding' ? '▲' : '▼'} ${esc(torrent.name)}</span><span class="tr" style="color:${color}">${rateText}</span><span class="tpct">${progressText}</span>${bar}</div>`;
  }).join('');
  const overflow = torrents.length > 5 ? `<div class="tmore">+${torrents.length - 5} more</div>` : '';
  const body = torrents.length
    ? `<div class="torrent-list">${rows}${overflow}</div>`
    : `<div class="panel-placeholder">${panel.state === 'error' ? 'QUERY ERROR' : 'NO DATA'}</div>`;
  updateCard('torrents', 'TORRENTS', panel.state, body);
}

function renderLibrary(panel) {
  const totalRows = panel.values.diskTotal || [];
  const availableRows = panel.values.diskAvailable || [];
  const total = totalRows.find(({ value }) => Number.isFinite(value))?.value;
  const available = availableRows.find(({ value }) => Number.isFinite(value))?.value;
  const used = Number.isFinite(total) && Number.isFinite(available) ? Math.max(0, total - available) : null;
  const appRows = panel.values.libraryItems || [];
  const hasAppTotals = appRows.length > 0;
  const appBytes = (name) => appRows.find((row) => row.labels.app === name)?.value;
  const movies = hasAppTotals ? appBytes('radarr') ?? 0 : null;
  const tv = hasAppTotals ? appBytes('sonarr') ?? 0 : null;
  const other = Number.isFinite(used) && Number.isFinite(movies) && Number.isFinite(tv)
    ? Math.max(0, used - movies - tv) : null;
  const rows = [
    ['Movies', movies, 'amber'],
    ['TV', tv, 'red'],
    ['Other', other, 'cyan'],
  ];
  const maxPart = Math.max(...rows.map(([, value]) => value ?? 0), 0);
  const appError = panel.failed.has('libraryItems') && !hasAppTotals;
  const storageError = (panel.failed.has('diskTotal') && !totalRows.length)
    || (panel.failed.has('diskAvailable') && !availableRows.length);
  const rowsHtml = rows.map(([name, value, color]) => {
    const readable = Number.isFinite(value)
      ? `${(value / BYTES_PER_TIB).toFixed(1)} TiB`
      : appError ? 'ERROR' : storageError && name === 'Other' ? 'ERROR' : 'NO DATA';
    const width = Number.isFinite(value) && maxPart > 0 ? `${(value / maxPart * 100).toFixed(0)}%` : '0%';
    return `<div class="lrow"><span>${name}</span><div class="lbar"><i style="width:${width};background:var(--${color})"></i></div><b>${readable}</b></div>`;
  }).join('');
  const usedText = Number.isFinite(used) ? `${(used / BYTES_PER_TIB).toFixed(1)} TiB` : storageError ? 'ERROR' : 'NO DATA';
  const totalText = Number.isFinite(total) ? `${(total / BYTES_PER_TIB).toFixed(1)} TiB`
    : panel.failed.has('diskTotal') ? 'ERROR' : 'NO DATA';
  const pct = Number.isFinite(used) && Number.isFinite(total) && total > 0 ? ` · ${Math.round(used / total * 100)}%` : '';
  const content = `<div class="lbig"><b>${usedText}</b><i> / ${totalText}${pct}</i></div>${rowsHtml}`;
  updateCard('library', 'LIBRARY STORAGE', panel.state, content);
}

function renderPlex(panel) {
  const activeRows = panel.values.plexActive || [];
  const active = activeRows.find(({ value }) => Number.isFinite(value))?.value;
  const sessions = (panel.values.plexSessions || []).filter((row) => row.value > 0);
  const transcodes = sessions.filter((row) => /transcod/i.test(row.labels.decision || '')).length;
  const transcodeText = panel.failed.has('plexSessions') && !panel.values.plexSessions?.length
    ? 'ERROR' : panel.values.plexSessions?.length ? String(transcodes) : active === 0 ? '0' : 'NO DATA';
  const activeText = metricValue(panel, 'plexActive', integer);
  const sessionRows = sessions.slice(0, 4).map((row) => {
    const title = row.labels.title || 'NO TITLE';
    const detail = [row.labels.decision, row.labels.player].filter(Boolean).join(' · ');
    return `<div class="pstream" title="${esc(`${title}${detail ? ` · ${detail}` : ''}`)}">▶ ${esc(title)}${detail ? ` · ${esc(detail)}` : ''}</div>`;
  }).join('');
  const overflow = sessions.length > 4 ? `<div class="pstream-more">+${sessions.length - 4} more sessions</div>` : '';
  const list = sessionRows || (active === 0 ? '<div class="panel-placeholder">NO ACTIVE SESSIONS</div>'
    : panel.failed.has('plexSessions') ? '<div class="panel-placeholder">QUERY ERROR</div>' : '<div class="panel-placeholder">NO SESSION DETAILS</div>');
  const content = `<div class="p3grid"><div><b>${activeText}</b><span>active sessions</span></div><div><b>${transcodeText}</b><span>transcodes</span></div></div><div class="pstreams">${list}${overflow}</div>`;
  updateCard('plex', 'PLEX', panel.state, content);
}

function renderArr(panel) {
  const scores = panel.values.score || [];
  const queues = panel.values.arrQueue || [];
  const issues = panel.values.arrHealth || [];
  const rows = ARR_SERVICES.map((service) => {
    const rawScore = scores.find((row) => row.labels.name === service)?.value;
    const score = Number.isFinite(rawScore) ? clamp(rawScore, 0, 10) : null;
    const scoreState = Number.isFinite(score)
      ? score >= SCORE_OK_MIN ? 'ok' : score >= SCORE_DEGRADED_MIN ? 'degraded' : 'down'
      : 'no-score';
    const scoreText = Number.isFinite(score) ? `${scoreState} · ${score.toFixed(1)}/10` : 'NO SCORE';
    const details = [];
    const queue = queues.find((row) => row.labels.app === service);
    const health = issues.find((row) => row.labels.app === service);
    if (queue) details.push(`q${integer(queue.value)}`);
    if (health) details.push(`${integer(health.value)} issues`);
    return `<div class="arow ${scoreState}"><span class="aname"><i></i>${esc(service)}</span><em>${esc(scoreText)}${details.length ? ` · ${esc(details.join(' · '))}` : ''}</em></div>`;
  }).join('');
  updateCard('arr', 'ARR STACK', panel.state, `<div class="agrid">${rows}</div>`);
}

function formatAge(timestamp) {
  if (!Number.isFinite(timestamp)) return 'AGE UNAVAILABLE';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderVpn(panel) {
  const tunnel = panel.values.vpnTunnel?.find(({ value }) => Number.isFinite(value))?.value;
  const handshake = panel.values.vpnHandshake?.find(({ value }) => Number.isFinite(value))?.value;
  const killswitch = panel.values.vpnKillswitch?.find(({ value }) => Number.isFinite(value))?.value;
  const portForward = panel.values.vpnPortForward?.find(({ value }) => Number.isFinite(value))?.value;
  const valueText = (key, value, format) => Number.isFinite(value)
    ? format(value) : panel.failed.has(key) ? 'ERROR' : 'NO DATA';
  const tunnelText = valueText('vpnTunnel', tunnel, (value) => value > 0 ? 'CONNECTED' : 'DOWN');
  const detail = [
    `handshake ${valueText('vpnHandshake', handshake, (value) => formatAge(value))}`,
    `killswitch ${valueText('vpnKillswitch', killswitch, (value) => value > 0 ? 'OK' : 'NOT OK')}`,
    `port-forward ${valueText('vpnPortForward', portForward, (value) => value > 0 ? 'ACTIVE' : 'INACTIVE')}`,
  ];
  $('vpn').textContent = `● WIREGUARD · ${tunnelText}`;
  $('vpnDetail').textContent = `${detail.join(' · ')}${panel.state === 'stale' ? ' · STALE' : panel.state === 'error' ? ' · QUERY ERROR' : ''}`;
  setState($('vpnPanel'), panel.state);
}

function renderPosters(panel) {
  const rows = [...(panel.values.recent || [])].sort((a, b) => b.value - a.value).slice(0, 8);
  const cards = rows.map((row, i) => {
    const title = row.labels.title || 'NO TITLE';
    return `<div class="poster" title="${esc(title)}" style="background:linear-gradient(${i * 45}deg,hsl(${20 + i * 40} 70% 30%),hsl(${200 + i * 20} 55% 14%))"><strong>${esc(title)}</strong><span>${formatAge(row.value)}</span></div>`;
  }).join('');
  const content = cards ? `<div class="pgrid">${cards}</div>`
    : `<div class="panel-placeholder">${panel.state === 'error' ? 'QUERY ERROR' : 'NO DATA'}</div>`;
  $('posters').innerHTML = `<div class="ct">RECENTLY ADDED${CARD_STATE_LABEL[panel.state] ? `<small class="state-label">${CARD_STATE_LABEL[panel.state]}</small>` : ''}</div>${content}`;
  setState($('posters'), panel.state);
}

function renderMediaPanels(panels) {
  renderQbit(panels.qbit);
  renderLibrary(panels.library);
  renderPlex(panels.plex);
  renderTorrents(panels.torrents);
  renderArr(panels.arr);
  renderVpn(panels.vpn);
  renderPosters(panels.recent);
}

async function refresh() {
  const r = await settle({
    score: () => query(Q.appScore),
    qbitDownload: () => query(Q.mc4QbitDownloadRate),
    qbitUpload: () => query(Q.mc4QbitUploadRate),
    qbitDht: () => query(Q.mc4QbitDhtNodes),
    qbitConnection: () => query(Q.mc4QbitConnection),
    torrentProgress: () => query(Q.mc4TorrentProgress),
    torrentDownload: () => query(Q.mc4TorrentDownloadRate),
    torrentUpload: () => query(Q.mc4TorrentUploadRate),
    torrentShareRatio: () => query(Q.mc4TorrentShareRatio),
    diskTotal: () => query(Q.mc4LibraryDiskTotal),
    diskAvailable: () => query(Q.mc4LibraryDiskAvailable),
    libraryItems: () => query(Q.mc4LibraryItems),
    plexActive: () => query(Q.mc4PlexActiveSessions),
    plexSessions: () => query(Q.mc4PlexSessions),
    arrQueue: () => query(Q.mc4ArrQueue),
    arrHealth: () => query(Q.mc4ArrHealthIssues),
    vpnTunnel: () => query(Q.mc4VpnTunnel),
    vpnHandshake: () => query(Q.mc4VpnHandshake),
    vpnKillswitch: () => query(Q.mc4VpnKillswitch),
    vpnPortForward: () => query(Q.mc4VpnPortForward),
    recent: () => query(Q.mc4RecentlyAdded),
  });
  model.scoreFailed = r.score === null;
  if (r.score !== null) {
    const seen = new Set();
    for (const row of r.score) {
      const app = appIndex[row.labels.name];
      if (app && Number.isFinite(row.value)) { app.s = clamp(row.value, 0, 10); seen.add(app.n); }
    }
    for (const app of apps) if (!seen.has(app.n)) app.s = null;
  }
  const panels = {
    qbit: retainPanel('qbit', {
      qbitDownload: r.qbitDownload, qbitUpload: r.qbitUpload, qbitDht: r.qbitDht,
      qbitConnection: r.qbitConnection, torrentProgress: r.torrentProgress, torrentShareRatio: r.torrentShareRatio,
    }),
    torrents: retainPanel('torrents', {
      torrentProgress: r.torrentProgress, torrentDownload: r.torrentDownload, torrentUpload: r.torrentUpload,
    }),
    library: retainPanel('library', { diskTotal: r.diskTotal, diskAvailable: r.diskAvailable, libraryItems: r.libraryItems }),
    plex: retainPanel('plex', { plexActive: r.plexActive, plexSessions: r.plexSessions }),
    arr: retainPanel('arr', { score: r.score, arrQueue: r.arrQueue, arrHealth: r.arrHealth }),
    vpn: retainPanel('vpn', {
      vpnTunnel: r.vpnTunnel, vpnHandshake: r.vpnHandshake, vpnKillswitch: r.vpnKillswitch, vpnPortForward: r.vpnPortForward,
    }),
    recent: retainPanel('recent', { recent: r.recent }),
  };
  renderApps();
  renderMediaPanels(panels);
}

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
    const health = model.fleetUpFrac ?? 0;
    // Slow camera drift (shock-and-awe): a gentle orbit around the sketch's own default position
    // so the hero scene reads as alive even beyond its own spin/flow animation.
    if (!RM) {
      cam.position.x = Math.sin(t * 0.1) * 50 + pointer.x * 20;
      cam.position.y = 40 + Math.sin(t * 0.07) * 20 + pointer.y * 10;
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
const guardedRefresh = guardRefresh(() => refresh().catch((e) => console.warn('refresh', e)));
await refresh().catch((e) => console.warn('refresh', e));
const refreshId = setInterval(guardedRefresh, (cfg.refreshSeconds || 15) * 1000);
onDispose(() => clearInterval(refreshId));
// Nightly reload keeps a 24/7 kiosk's memory flat.
setTimeout(() => location.reload(), 24 * 3600 * 1000);
