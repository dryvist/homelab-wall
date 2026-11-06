import { adaptiveDpr, clamp, hue } from '/lib/stage.js';
import { ANCHOR_DEFS } from './accelerators.js';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ANCHOR_COLOR = { gpu: '#3ee6ff', mac: '#38ff9c', cloud: '#ffb347' };
const BEAD_RING = 12, BEAD_CAP = 36;
function fitCanvas(cv) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}

// Bead count per anchor as the 2D fallback eases it (the 3D scene keeps its own copy).
const beadShown = ANCHOR_DEFS.map(() => 0);
let lastDraw = 0;
export function drawReactor(reactor, now, { list, accel, slots, isDim }) {
  const dpr = fitCanvas(reactor);
  const c = reactor.getContext('2d'), W = reactor.width, H = reactor.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3;
  c.clearRect(0, 0, W, H);
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 2.2);
  g.addColorStop(0, 'rgba(255,79,216,.10)'); g.addColorStop(1, 'rgba(4,3,8,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);

  const upFrac = list.length ? list.filter((m) => m.up).length / list.length : 0;
  const col = list.length ? hue(upFrac * 100) : '#3a2440';
  const t = RM ? 0 : now / 1000;
  const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.1) : 0;
  lastDraw = now;
  const at = (i) => ({ x: slots[i].x * dpr, y: slots[i].y * dpr });

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
  c.fillText(list.length ? `${Math.round(upFrac * 100)}%` : '—', cx, cy);

  // Models orbit the anchor they are attached to. streams counts the models whose stream is drawn.
  let streams = 0;
  const perAnchor = ANCHOR_DEFS.map(() => 0);
  for (const m of list) perAnchor[m.anchor] += 1;
  const seenAt = ANCHOR_DEFS.map(() => 0);
  for (const m of list) {
    const k = seenAt[m.anchor]++, n = perAnchor[m.anchor];
    const p = at(m.anchor);
    const a = (k / n) * Math.PI * 2 + t * 0.25;
    const x = p.x + Math.cos(a) * R * 0.42, y = p.y + Math.sin(a) * R * 0.21;
    c.beginPath(); c.arc(x, y, (m.up ? 4 : 3) * dpr, 0, Math.PI * 2);
    c.fillStyle = m.up ? (m.tok > 0.05 ? '#38ff9c' : '#3ee6ff') : '#ff3b5c';
    c.shadowColor = c.fillStyle; c.shadowBlur = 8 * dpr; c.fill(); c.shadowBlur = 0;
    // An up model with tokens in flight streams from its dot into the hub: travelling sparks, the 2D
    // stand-in for the 3D stream. The same gate as the 3D stream.
    if (m.up && m.tok > 0.05) {
      streams += 1;
      for (let s = 0; s < 3; s++) {
        const f = (t * 0.3 + s / 3 + k * 0.21) % 1;
        c.beginPath(); c.arc(x + (cx - x) * f, y + (cy - y) * f, 1.6 * dpr, 0, Math.PI * 2);
        c.globalAlpha = Math.sin(f * Math.PI) * 0.9;
        c.fillStyle = m.tok > 0.05 ? '#38ff9c' : '#3ee6ff'; c.fill();
      }
      c.globalAlpha = 1;
    }
  }
  // Read by the render-path checks: the count of streams drawn this frame (3D records the same on its canvas).
  reactor.dataset.streams = String(streams);

  // Anchor nodes (labelled by the DOM layer): a compact glow, an outline core sized by busy %, a
  // hairline halo and the busy arc, then the request beads. Nothing fills the node, so the particles
  // behind it stay visible; an idle or no-data node is an outline only.
  const dimmedIds = []; // the anchors drawn dim this frame, read by the render-path checks
  accel.forEach((d, i) => {
    const p = at(i), color = ANCHOR_COLOR[d.kind], dimmed = isDim(d);
    if (dimmed) dimmedIds.push(d.id);
    const lit = d.busy == null ? 0 : clamp(d.busy / 100, 0, 1);
    // Core radius 20-35 CSS px (a 40-70 px node at 1920x1080), scaled with the viewport height.
    const r0 = (20 + 15 * lit) * (Math.min(reactor.clientWidth, reactor.clientHeight) / 1080) * dpr;
    if (!dimmed) {
      const halo = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r0 * 2.2);
      halo.addColorStop(0, `${color}40`); halo.addColorStop(1, `${color}00`);
      c.fillStyle = halo; c.beginPath(); c.arc(p.x, p.y, r0 * 2.2, 0, Math.PI * 2); c.fill();
    }
    c.beginPath(); c.arc(p.x, p.y, r0 * 1.9, 0, Math.PI * 2);
    c.strokeStyle = `${color}${dimmed ? '1a' : '38'}`; c.lineWidth = dpr; c.stroke();
    c.beginPath();
    if (d.kind === 'cloud') {
      c.moveTo(p.x, p.y - r0); c.lineTo(p.x + r0, p.y); c.lineTo(p.x, p.y + r0); c.lineTo(p.x - r0, p.y); c.closePath();
    } else {
      c.arc(p.x, p.y, r0, 0, Math.PI * 2);
    }
    c.strokeStyle = dimmed ? `${color}80` : color; c.lineWidth = (dimmed ? 1.5 : 2.5) * dpr; c.stroke();
    if (d.busy != null) {
      c.beginPath(); c.arc(p.x, p.y, r0 + 6 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * lit);
      c.strokeStyle = color; c.lineWidth = 3 * dpr; c.stroke();
    }

    const target = Math.min(d.active, BEAD_CAP);
    beadShown[i] += (target - beadShown[i]) * (1 - Math.exp(-dt * 3));
    const n = Math.min(BEAD_CAP, Math.max(target, Math.ceil(beadShown[i] - 1e-3)));
    const rings = n > BEAD_RING ? Math.ceil(n / BEAD_RING) : 1;
    for (let k = 0; k < n; k++) {
      const fade = clamp(beadShown[i] - k, 0, 1);
      if (fade <= 0) continue;
      const ring = k % rings, j = Math.floor(k / rings), inRing = Math.ceil((n - ring) / rings);
      const phi = (j / inRing) * Math.PI * 2 + ring * 0.9 + (ring % 2 ? -1 : 1) * t * (0.9 / (1 + ring * 0.35));
      const rr = R * (0.2 + ring * 0.05);
      const x = p.x + Math.cos(phi) * rr, y = p.y + Math.sin(phi) * rr * 0.4;
      c.beginPath(); c.arc(x, y, (rings > 1 ? 2.2 : 3.2) * dpr * fade, 0, Math.PI * 2);
      c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 10 * dpr; c.fill(); c.shadowBlur = 0;
    }
  });
  reactor.dataset.dimAnchors = dimmedIds.join(',');
}

