import { esc, hue, scorePct, SCORE_OK_MIN, SCORE_DEGRADED_MIN, setState } from '/lib/stage.js';
const $ = (id) => document.getElementById(id);

export function renderKpis(model, aiApps) {
  const up = model.models.filter((m) => m.up).length;
  const k = [
    ['tokens today', model.tokensToday == null ? 'NO DATA' : (model.tokensToday / 1e6).toFixed(2), model.tokensToday == null ? '' : 'M'],
    ['requests/min', model.reqPerMin == null ? 'NO DATA' : model.reqPerMin.toFixed(0), ''],
    ['active', model.inflight == null ? 'NO DATA' : String(Math.round(model.inflight)), ''],
    ['models up', model.models.length ? `${up}/${model.models.length}` : 'NO DATA', ''],
  ];
  $('kpis').innerHTML = k.map(([l, v, u]) => `<div class="kpi"><b class="num">${v}<i>${u}</i></b><span>${l}</span></div>`).join('');
  $('subtitle').textContent = `${aiApps.length} SERVICES · ${model.models.length} MODELS`;
}

/* ---------------- fleet health (mandatory "apps" panel) ---------------- */
function drawRing(el, score) {
  const c = el.getContext('2d'), W = el.width, H = el.height, cx = W / 2, cy = H / 2, r = W * 0.4;
  c.clearRect(0, 0, W, H); c.lineWidth = W * 0.08;
  c.strokeStyle = '#28102f'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
  if (score != null) {
    c.strokeStyle = hue(scorePct(score)); c.shadowColor = hue(scorePct(score)); c.shadowBlur = W * 0.05;
    c.beginPath(); c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * score / 10); c.stroke(); c.shadowBlur = 0;
  }
  c.fillStyle = '#fff'; c.font = `600 ${W * 0.14}px "Chakra Petch",sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(score == null ? 'NO DATA' : Math.round(score), cx, cy - H * 0.03);
  c.fillStyle = '#8a5d90'; c.font = `${W * 0.055}px "JetBrains Mono",monospace`; c.fillText('HEALTH', cx, cy + H * 0.14);
}

export function renderApps(aiApps) {
  const scores = aiApps.map((a) => a.s);
  const ok = scores.filter((s) => s >= SCORE_OK_MIN).length;
  const warn = scores.filter((s) => s >= SCORE_DEGRADED_MIN && s < SCORE_OK_MIN).length;
  const bad = scores.filter((s) => s < SCORE_DEGRADED_MIN).length;
  $('appsum').innerHTML = `<span style="color:var(--green)">${ok} OK</span> &middot; <span style="color:var(--amber)">${warn} DEG</span> &middot; <span style="color:var(--red)">${bad} DOWN</span>`;
  $('applist').innerHTML = aiApps.map((a) => `<div class="ar"><i style="background:${hue(scorePct(a.s))}"></i><span>${esc(a.n)}</span><b class="num">${Math.round(a.s)}</b></div>`).join('');
  drawRing($('fleetRing'), scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null);
  setState($('apps'), scores.length ? 'ok' : 'empty', scores.length ? '' : 'NO SERVICE DATA');
}

