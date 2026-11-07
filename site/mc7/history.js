import { adaptiveDpr } from '../lib/stage.js';

// Samples are positioned by timestamp. A missing scrape breaks the path.
export function drawSpark(canvas, history, color) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w; canvas.height = h;
  const samples = history?.values || [];
  const valid = ([t, v]) => Number.isFinite(t) && Number.isFinite(v) && t >= history.start && t <= history.end;
  const values = samples.filter(valid);
  canvas.dataset.samples = String(values.length);
  canvas.dataset.state = Number.isFinite(history?.staleSince) ? 'stale' : 'ok';
  const stale = Number.isFinite(history?.staleSince)
    ? `, STALE ${Math.max(0, Math.floor(Date.now() / 1000 - history.staleSince))}s` : '';
  canvas.setAttribute('aria-label', `${canvas.dataset.kind} tok/s, last 10 minutes${values.length ? '' : ': NO DATA'}${stale}`);
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (!values.length || history.end <= history.start) return;
  const max = Math.max(1, ...values.map(([, v]) => v));
  c.beginPath();
  let previous = null;
  for (const [t, v] of samples) {
    if (!valid([t, v])) { previous = null; continue; }
    const pen = previous != null && t > previous && t - previous <= history.step;
    const x = (t - history.start) / (history.end - history.start) * w;
    const y = h - v / max * (h - 2 * dpr) - dpr;
    if (pen) c.lineTo(x, y); else c.moveTo(x, y);
    previous = t;
  }
  c.strokeStyle = color; c.lineWidth = 1.5 * dpr; c.lineJoin = 'round'; c.stroke();
}
