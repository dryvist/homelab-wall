import { query, range, settle } from '../lib/prom.js';
import { Q } from '../lib/queries.js';
import { BENCHMARK_Q, ROUTER_AVERAGES_UNAVAILABLE } from '../lib/benchmarkQueries.js';
import { esc, adaptiveDpr, clamp, hue, setState } from '../lib/stage.js';

const $ = (id) => document.getElementById(id);
const finite = (n) => Number.isFinite(n);
const value = (rows, labels) => rows?.find((r) => Object.entries(labels).every(([k, v]) => r.labels[k] === v))?.value;
const number = (n, unit = '', digits = 1) => finite(n) ? `${n.toFixed(digits)}${unit}` : 'NO DATA';
const duration = (n) => finite(n) ? (n < 1 ? `${Math.round(n * 1000)}ms` : n < 60 ? `${n.toFixed(1)}s` : `${(n / 60).toFixed(1)}m`) : 'NO DATA';

export async function loadBenchmarks() {
  return settle({
    ...Object.fromEntries(Object.entries(BENCHMARK_Q).map(([key, expr]) => [key, () => query(expr)])),
    engineDecodeHistory: () => range(Q.engineDecode, 10, 15),
    enginePrefillHistory: () => range(Q.enginePrefill, 10, 15),
    routerDecodeHistory: () => range(Q.llmTokRate, 10, 15),
    routerPrefillHistory: () => range(Q.routerInput, 10, 15),
  });
}

// Preserve missing samples as gaps, without seeding or repeating invented history.
export function drawSpark(canvas, history, color) {
  const dpr = adaptiveDpr();
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w; canvas.height = h;
  const samples = (history?.values || []).map((v, i) => [history.timestamps[i], v]);
  const valid = ([t, v]) => finite(t) && finite(v) && t >= history.start && t <= history.end;
  canvas.dataset.samples = String(samples.filter(valid).length);
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (!samples.some(valid)) return;
  const max = Math.max(1, ...samples.filter(valid).map(([, v]) => v));
  c.beginPath();
  let previous = null;
  samples.forEach(([t, v]) => {
    if (!valid([t, v])) { previous = null; return; }
    const pen = previous != null && t > previous && t - previous <= history.step;
    const x = (t - history.start) / (history.end - history.start) * w, y = h - v / max * (h - 2 * dpr) - dpr;
    if (pen) c.lineTo(x, y); else c.moveTo(x, y);
    previous = t;
  });
  c.strokeStyle = color; c.lineWidth = 1.5 * dpr; c.lineJoin = 'round'; c.stroke();
}

function readout(label, text, key) {
  return `<div class="bench-readout"><span>${label}</span><b data-metric="${key}">${text}</b></div>`;
}

export function renderBenchmarks(models, data, accelerators) {
  const identities = new Map();
  for (const [key, rows] of Object.entries(data)) {
    if (!key.startsWith('engine') || key.endsWith('History')) continue;
    for (const { labels } of rows || []) identities.set(`${labels.backend}\0${labels.model}`, { backend: labels.backend, model: labels.model });
  }
  const engines = [...identities.values()].map((labels) => ({ n: labels.model || 'unnamed model', labels, backend: labels.backend }));
  const cards = [...engines, ...models.map((m) => ({ ...m, labels: { model: m.n }, backend: 'router' }))];
  const tab = $('modeltab');
  tab.style.gridTemplateColumns = `repeat(${Math.max(cards.length, 1)},minmax(260px,1fr))`;
  tab.classList.toggle('dense', cards.length > 5);
  tab.innerHTML = cards.length ? cards.map((m) => {
    const router = m.backend === 'router';
    const get = (key) => value(data[key], m.labels);
    const decode = router ? m.tok : get('engineDecode');
    const prefill = get(router ? 'routerInput' : 'enginePrefill');
    const latency = router
      ? readout('TTFT avg', ROUTER_AVERAGES_UNAVAILABLE, 'ttft-avg') + readout('Output token latency avg', ROUTER_AVERAGES_UNAVAILABLE, 'itl-avg')
      : ['50', '95', '99'].map((p) => readout(`TTFT p${p}`, duration(get(`engineTtftP${p}`)), `ttft-p${p}`)).join('')
        + ['50', '99'].map((p) => readout(`ITL p${p}`, duration(get(`engineItlP${p}`)), `itl-p${p}`)).join('');
    const device = router ? accelerators[m.anchor].name : `${m.backend} · engine telemetry`;
    const role = router ? accelerators[m.anchor].id : m.backend === 'vllm' ? 'gpu-primary' : 'gpu-secondary';
    return `<div class="mc" data-backend="${esc(m.backend)}" data-model="${esc(m.n)}">
      <div class="mch"><b title="${esc(m.n)}">${esc(m.n.split('/').pop())}</b><span>${router ? (m.up ? 'UP' : 'DOWN') : esc(m.backend)}</span></div>
      <div class="mcat" title="${esc(device)}">${esc(device)}</div>
      <div class="mctok">${number(decode)}<i>${router ? 'router output' : 'decode'} tok/s</i></div>
      <canvas class="mcspark" data-history="${router ? 'routerDecodeHistory' : 'engineDecodeHistory'}" aria-label="${router ? 'Output' : 'Decode'} tok/s, last 10 minutes"></canvas>
      ${readout(router ? 'Router input tok/s' : 'Prefill tok/s', number(prefill), 'prefill')}
      <canvas class="mcspark prefill" data-history="${router ? 'routerPrefillHistory' : 'enginePrefillHistory'}" aria-label="${router ? 'Input' : 'Prefill'} tok/s, last 10 minutes"></canvas>
      <div class="bench-grid">${latency}
      ${readout('Running / waiting', router ? 'NO DATA' : `${number(get('engineRunning'), '', 0)} / ${number(get('engineWaiting'), '', 0)}`, 'concurrency')}
      ${readout('KV', router ? 'NO DATA' : number(get('engineKvPercent'), '%'), 'kv')}
      ${readout('Prefix hit', router ? 'NO DATA' : number(get('enginePrefixPercent'), '%'), 'prefix')}
      ${readout('Spec acceptance', router ? 'NO DATA' : number(get('engineSpecPercent'), '%'), 'spec')}
      ${readout('Device W · 5m avg', number(value(data.acceleratorWatts, { accelerator: role }), ' W'), 'watts')}
      ${readout('Device tok/J · 1h', number(value(data.acceleratorTokensPerJoule, { accelerator: role }), '', 3), 'efficiency')}
      </div><div class="mcstats">${router ? `queue avg / API avg <b>${ROUTER_AVERAGES_UNAVAILABLE}</b>` : `5m rates · energy totals for ${esc(role)}`}</div>
      ${router ? '<div class="mcv">Engine prefill, percentiles, cache, and power attribution unavailable</div>' : ''}
      </div>`;
  }).join('') : '<div class="cfnote">NO ENGINE OR ROUTER DATA</div>';
  cards.forEach((m, i) => {
    for (const canvas of tab.children[i].querySelectorAll('canvas')) {
      const rows = data[canvas.dataset.history];
      const history = rows?.find((r) => Object.entries(m.labels).every(([k, v]) => r.labels[k] === v));
      drawSpark(canvas, history, canvas.classList.contains('prefill') ? '#ff4fd8' : '#3ee6ff');
    }
  });
  $('coresum').textContent = `${engines.length} ENGINES · ${models.length} ROUTER MODELS`;
  setState($('cores'), cards.length ? 'ok' : 'empty', cards.length ? '' : 'NO DATA');
}

export function renderCoreExtra(model, data) {
  $('cxReqMin').textContent = number(model.reqPerMin, '', 0);
  const gpuPct = model.gpuBusy;
  $('cxGpu').textContent = gpuPct == null ? 'NO FEED' : `${Math.round(gpuPct)}%`;
  $('cxGpu').dataset.feed = gpuPct == null ? 'none' : 'live';
  const gauge = $('gpuGauge'), gc = gauge.getContext('2d');
  gauge.width = Math.max(1, Math.round(gauge.clientWidth * adaptiveDpr()));
  gc.clearRect(0, 0, gauge.width, gauge.height);
  gc.fillStyle = '#200a28'; gc.fillRect(0, 0, gauge.width, gauge.height);
  if (gpuPct != null) { gc.fillStyle = hue(gpuPct); gc.fillRect(0, 0, gauge.width * clamp(gpuPct, 0, 100) / 100, gauge.height); }
  $('modelSparks').innerHTML = ['gpu-primary', 'gpu-secondary', 'mac-primary'].map((accelerator) => {
    const labels = { accelerator };
    return `<div class="device-power" data-accelerator="${accelerator}"><b>${accelerator}</b>
      ${readout('Device W · 5m avg', number(value(data.acceleratorWatts, labels), ' W'), 'watts')}
      ${readout('Device tok/J · 1h', number(value(data.acceleratorTokensPerJoule, labels), '', 3), 'efficiency')}</div>`;
  }).join('');
}
