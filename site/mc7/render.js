import { esc, setState } from '../lib/stage.js';
import { identities, matches } from './data.js';
import { drawSpark } from './history.js';

const number = (n, unit = '', digits = 1) => Number.isFinite(n) ? `${n.toFixed(digits)}${unit}` : 'NO DATA';
const duration = (n) => Number.isFinite(n) ? (n < 1 ? `${Math.round(n * 1000)}ms` : `${n.toFixed(1)}s`) : 'NO DATA';
const age = (timestamp) => {
  if (!Number.isFinite(timestamp)) return 'age unavailable';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

function metric(data, stale, labels, key, format = number) {
  const row = data[key]?.find((row) => matches(row, labels));
  const n = row?.value;
  const hasReading = Number.isFinite(n) || row?.idle;
  const old = stale.get(key)?.has(row);
  const title = Number.isFinite(row?.sourceTimestamp)
    ? `Last measured ${new Date(row.sourceTimestamp * 1000).toISOString()}` : 'Measurement time unavailable';
  return `<b data-metric="${esc(key)}"${hasReading ? ` title="${esc(title)}"${old ? ' data-state="stale"' : ''}` : ''}>${row?.idle ? 'Idle' : format(n)}${old && hasReading ? ` · STALE ${age(row.sourceTimestamp)}` : ''}</b>`;
}

const field = (label, content) => `<div><dt>${label}</dt><dd>${content}</dd></div>`;
const panelStale = (stale, router) => [...stale].some(([key, rows]) => rows.size > 0
  && (router ? key.startsWith('router') || key === 'llmTokRate'
    : key.startsWith('engine') || key === 'acceleratorWatts' || key === 'acceleratorTokensPerJoule'));
const historyLabel = (history) => Number.isFinite(history?.staleSince)
  ? `<small data-state="stale">STALE ${age(history.staleSince)}</small>` : '';

function engineCard(labels, data, stale) {
  const title = labels.backend === 'llamacpp' ? `${labels.guest} · llama.cpp` : labels.model;
  const m = (key, format) => metric(data, stale, labels, key, format);
  const latencies = [
    ['TTFT p50', 'engineTtftP50'], ['TTFT p95', 'engineTtftP95'], ['TTFT p99', 'engineTtftP99'],
    ['ITL p50', 'engineItlP50'], ['ITL p99', 'engineItlP99'], ['E2E p95', 'engineE2eP95'],
  ].map(([label, key]) => field(label, m(key, duration))).join('');
  const devices = [...new Set((data.engineDevices || []).filter((row) => matches(row, labels)).map((row) => row.labels.accelerator).filter(Boolean))];
  const power = devices.map((accelerator) => {
    const id = { accelerator };
    const associationStale = (data.engineDevices || []).some((row) => matches(row, labels)
      && row.labels.accelerator === accelerator && stale.get('engineDevices')?.has(row)) ? ' · STALE association' : '';
    return `<div class="power"><p>${esc(accelerator)} device totals${associationStale}</p><dl>
      ${field('Watts · 5m mean', metric(data, stale, id, 'acceleratorWatts', (n) => number(n, ' W')))}
      ${field('Tokens / joule · 1h', metric(data, stale, id, 'acceleratorTokensPerJoule', (n) => number(n, '', 3)))}</dl></div>`;
  }).join('');
  return `<article class="card" data-backend="${esc(labels.backend)}" data-model="${esc(title)}">
    <h3>${esc(title)}</h3><p class="backend">${esc(labels.backend)}</p>
    <div class="throughput">${['Decode', 'Prefill'].map((kind) => {
      const history = data[`engine${kind}History`]?.find((row) => matches(row, labels));
      return `<div class="rate ${kind === 'Prefill' ? 'prefill' : ''}"><span>${kind} tok/s</span>${m(`engine${kind}`)}<canvas role="img" data-kind="${kind}"></canvas>${historyLabel(history)}</div>`;
    }).join('')}</div>
    <dl>${latencies}${field('Running', m('engineRunning', (n) => number(n, '', 0)))}${field('Waiting', m('engineWaiting', (n) => number(n, '', 0)))}
    ${field('KV cache', m('engineKvPercent', (n) => number(n, '%')))}${field('Prefix hit', m('enginePrefixPercent', (n) => number(n, '%')))}
    ${field('Spec acceptance', m('engineSpecPercent', (n) => number(n, '%')))}</dl>
    ${power || '<div class="power"><p>Device watts / tokens per joule: NO DATA · accelerator association unavailable</p></div>'}</article>`;
}

function routerCard(labels, data, stale) {
  const m = (key, format) => metric(data, stale, labels, key, format);
  return `<article class="card" data-backend="router" data-model="${esc(labels.model)}"><h3>${esc(labels.model)}</h3>
    <p class="backend">Router accounting</p><dl>
    ${field('TTFT p50', m('routerTtftP50', duration))}${field('TTFT p95', m('routerTtftP95', duration))}${field('E2E p95', m('routerE2eP95', duration))}
    ${field('Output tok/s', m('llmTokRate'))}${field('Input tok/s', m('routerInput'))}</dl></article>`;
}

export function renderBenchmarks({ data, stale, failed }) {
  for (const [id, router] of [['engines', false], ['routers', true]]) {
    const panel = document.getElementById(id);
    const cards = identities(data, router);
    setState(panel, cards.length ? (panelStale(stale, router) ? 'stale' : 'ok') : failed ? 'error' : 'empty');
    panel.innerHTML = cards.length ? cards.map((labels) => (router ? routerCard : engineCard)(labels, data, stale)).join('') : 'NO DATA';
    if (!router) cards.forEach((labels, i) => {
      for (const canvas of panel.children[i].querySelectorAll('canvas')) {
        const key = `engine${canvas.dataset.kind}History`;
        const history = data[key]?.find((row) => matches(row, labels));
        drawSpark(canvas, history, canvas.dataset.kind === 'Decode' ? '#87c9ff' : '#e6bb7a');
      }
    });
  }
}
