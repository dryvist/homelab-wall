import { query, range } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { loadConfig, loop, observeCanvas, onDispose } from '/lib/stage.js';
import { shapeNodes, ageLabel, refreshNode, withTimeout } from './model.js';

const panel = document.getElementById('constellation');
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');
const container = document.getElementById('nodes');
const motion = document.getElementById('motion');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const TAU = 2 * Math.PI;
let paused = reduced.matches;
let nodes = shapeNodes({});
const feeds = {};
let stopped = false;
let pollTimer;
let historyAt = 0;

// All text is static role vocabulary or a validated number, never a metric identity.
const elements = new Map(nodes.map((node) => {
  const el = document.createElement('article');
  el.className = 'node';
  el.dataset.node = node.id;
  el.style.left = `${node.x * 100}%`;
  el.style.top = `${node.y * 100}%`;
  el.style.setProperty('--signal', node.color);
  el.innerHTML = '<div class="orb"></div><h2></h2><div class="rate"></div><p class="age"></p><p class="history"></p>';
  el.querySelector('h2').textContent = node.label;
  container.appendChild(el);
  return [node.id, el];
}));

function renderLabels() {
  const now = Date.now() / 1000;
  nodes = nodes.map((node) => refreshNode(node, now));
  for (const node of nodes) {
    const el = elements.get(node.id);
    el.dataset.state = node.state;
    el.querySelector('.rate').textContent = node.rate == null ? 'Pending · no activity data'
      : `${node.state === 'stale' ? 'STALE · ' : ''}${node.rate.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${node.unit}`;
    el.querySelector('.age').textContent = node.state === 'stale'
      ? now - node.seenAt < 300 ? `STALE ${ageLabel(node.seenAt, now)}` : `STALE since ${new Date(node.seenAt * 1000).toISOString().slice(11, 19)} UTC`
      : `Last seen: ${ageLabel(node.lastActive, now)}`;
    el.querySelector('.history').textContent = node.historyStale ? 'History stale'
      : node.historyPending ? 'History pending' : '';
  }
  const measured = nodes.filter((n) => n.state === 'active' || n.state === 'idle');
  // Stale history marks the page only where a history ring is drawn.
  const stale = nodes.some((n) => n.state === 'stale' || (n.historyStale && !n.historyPending));
  panel.dataset.state = stale ? 'stale' : measured.length ? 'ok' : 'pending';
  document.getElementById('status').textContent = `${measured.length} signals reporting · ${nodes.filter((n) => n.state === 'pending').length} pending${stale ? ' · STALE data' : ''}`;
  document.getElementById('clock').textContent = new Date().toLocaleTimeString();
}

function circle(x, y, r) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
}

function draw(ms) {
  const box = panel.getBoundingClientRect();
  if (!box.width || !box.height) return;
  ctx.setTransform(canvas.width / box.width, 0, 0, canvas.height / box.height, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  const spots = new Map(nodes.map((n) => {
    const b = elements.get(n.id).querySelector('.orb').getBoundingClientRect();
    return [n.id, { x: b.left - box.left + b.width / 2, y: b.top - box.top + b.height / 2, r: b.height * .44 }];
  }));
  // Lines encode the declared agent hierarchy, never inferred calls or network traffic.
  ctx.strokeStyle = '#354460'; ctx.lineWidth = 1;
  for (const node of nodes.filter((n) => n.parent)) {
    const from = spots.get(node.parent), to = spots.get(node.id);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  for (const node of nodes) {
    const { x, y, r } = spots.get(node.id);
    const active = node.state === 'active';
    ctx.strokeStyle = '#354460';
    ctx.setLineDash(node.state === 'pending' ? [2, 5] : []);
    circle(x, y, r); ctx.stroke(); ctx.setLineDash([]);
    const maximum = Math.max(0, ...node.ring.filter((v) => v !== null));
    node.ring.forEach((v, i) => {
      if (v === null) return;
      ctx.beginPath();
      ctx.arc(x, y, r, -TAU / 4 + TAU * i / 288, -TAU / 4 + TAU * (i + .7) / 288);
      ctx.strokeStyle = v > 0 ? node.color : '#596680';
      ctx.globalAlpha = v > 0 ? .3 + .7 * v / maximum : .35;
      ctx.lineWidth = v > 0 ? 3 : 1; ctx.stroke();
    });
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
    if (node.rate === null) continue;
    // Monotone area scale: zero is a quiet point; growing rates approach the history ring.
    const radius = 3 + r * .62 * Math.sqrt(node.rate / (1 + node.rate));
    if (active) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.3);
      glow.addColorStop(0, `${node.color}88`); glow.addColorStop(1, `${node.color}00`);
      ctx.fillStyle = glow; circle(x, y, radius * 2.3); ctx.fill();
    }
    ctx.globalAlpha = active ? (paused ? 1 : .85 + .15 * Math.sin(ms / 1600)) : .35;
    ctx.fillStyle = node.state === 'stale' ? '#f6c780' : node.color;
    circle(x, y, radius); ctx.fill(); ctx.globalAlpha = 1;
  }
}

function motionLabel() {
  motion.textContent = paused ? 'Resume motion' : 'Pause motion';
  motion.setAttribute('aria-pressed', String(paused));
}
motion.addEventListener('click', () => { paused = !paused; motionLabel(); });
const motionChanged = () => { paused = reduced.matches; motionLabel(); };
reduced.addEventListener('change', motionChanged);
onDispose(() => reduced.removeEventListener('change', motionChanged));
observeCanvas(panel, canvas);
motionLabel();
renderLabels();
loop(20, (ms) => draw(ms));
const clockTimer = setInterval(renderLabels, 1000);
onDispose(() => { stopped = true; clearTimeout(pollTimer); clearInterval(clockTimer); });

async function poll(refresh) {
  const now = Date.now() / 1000;
  const historyDue = now - historyAt >= 300;
  const keys = [...new Set(nodes.map((n) => n.signal).filter(Boolean))];
  await Promise.all(keys.map(async (key) => {
    const tasks = [withTimeout(query(Q[key], { timestamps: true }))];
    // Native range queries; no polling a 24h subquery every fifteen seconds.
    if (historyDue) tasks.push(withTimeout(range(Q[key], 1440, 300, { timestamps: true, align: true })));
    const result = await Promise.allSettled(tasks);
    feeds[key] ||= {};
    feeds[key].current = result[0].status === 'fulfilled' ? result[0].value : null;
    if (historyDue) {
      feeds[key].historyFailed = result[1].status === 'rejected';
      if (!feeds[key].historyFailed) Object.assign(feeds[key], { history: result[1].value, historyAt: now });
    }
  }));
  if (stopped) return;
  if (historyDue) historyAt = now;
  nodes = shapeNodes(feeds, nodes);
  renderLabels();
  pollTimer = setTimeout(() => poll(refresh), refresh);
}

const cfg = await loadConfig().catch(() => ({}));
poll(Math.max(1000, (Number(cfg.refreshSeconds) || 15) * 1000));
