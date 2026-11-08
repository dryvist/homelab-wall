import { query } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { loop, onDispose, loadConfig, signalReady } from '/lib/stage.js';
import { shapeRates, splitInFlight, retain, modelKey, fresh, shareState, withSourceTimes, increased, bounded, windowAge, windowLabel, refreshMs, REQUEST_TIMEOUT_MS, ZERO_WHEN_EMPTY, IDLE_WHEN_EMPTY, feedValue } from './data.js';
import { formatPair, groupCallerRows, pinCallers, pinRules, renderInsights } from './metrics.js';
import { moreTerminal, callerMarkup, modelMarkup, fitRows, compactRoutes } from './layout.js';
import { createWireDrawer } from './wires.js';

const $ = (id) => document.getElementById(id);
const board = $('switchboard'), canvas = $('wires'), ctx = canvas.getContext('2d');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const wireDrawer = createWireDrawer(board, $('diagram'), canvas, $('hub'), ctx, motion);
const number = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const classPair = formatPair;
const feeds = {};
const keys = ['mc8InputRate', 'mc8OutputRate', 'mc8InputSourceTime', 'mc8OutputSourceTime', 'mc8InFlight', 'vllmRunning', 'llamaRunning', 'mc8SpendCents', 'mc8TtftLocalP95', 'mc8TtftCloudP95', 'mc8Failures', 'mc8Fallbacks',
  'mc8RequestsPerMinute', 'mc8RequestsSourceTime', 'mc8RequestLatencyLocalP50', 'mc8RequestLatencyCloudP50', 'mc8RequestLatencyLocalP95', 'mc8RequestLatencyCloudP95', 'mc8RequestLatencyLocalSourceTime', 'mc8RequestLatencyCloudSourceTime',
  'mc8Failures15m', 'mc8Fallbacks15m', 'mc8Failures15mSourceTime', 'mc8Fallbacks15mSourceTime', 'mc8TopModelsLocal', 'mc8TopModelsCloud', 'mc8TopModelsLocalSourceTime', 'mc8TopModelsCloudSourceTime',
  'mc8InFlightSourceTime', 'mc8VllmSourceTime', 'mc8LlamaSourceTime', 'mc8SpendSourceTime', 'mc8TtftLocalSourceTime', 'mc8TtftCloudSourceTime', 'mc8FailuresSourceTime', 'mc8FallbacksSourceTime'];
const feedKeys = keys.filter((key) => !key.endsWith('SourceTime'));
const IN_FLIGHT_KEYS = ['mc8InFlight', 'vllmRunning', 'llamaRunning'];
const TTFT_KEYS = ['mc8TtftLocalP95', 'mc8TtftCloudP95'];
const sourceTimes = {
  mc8InputRate: 'mc8InputSourceTime', mc8OutputRate: 'mc8OutputSourceTime', mc8InFlight: 'mc8InFlightSourceTime',
  vllmRunning: 'mc8VllmSourceTime', llamaRunning: 'mc8LlamaSourceTime', mc8SpendCents: 'mc8SpendSourceTime',
  mc8TtftLocalP95: 'mc8TtftLocalSourceTime', mc8TtftCloudP95: 'mc8TtftCloudSourceTime',
  mc8Failures: 'mc8FailuresSourceTime', mc8Fallbacks: 'mc8FallbacksSourceTime',
  mc8RequestsPerMinute: 'mc8RequestsSourceTime',
  mc8RequestLatencyLocalP50: 'mc8RequestLatencyLocalSourceTime', mc8RequestLatencyLocalP95: 'mc8RequestLatencyLocalSourceTime',
  mc8RequestLatencyCloudP50: 'mc8RequestLatencyCloudSourceTime', mc8RequestLatencyCloudP95: 'mc8RequestLatencyCloudSourceTime',
  mc8Failures15m: 'mc8Failures15mSourceTime', mc8Fallbacks15m: 'mc8Fallbacks15mSourceTime',
  mc8TopModelsLocal: 'mc8TopModelsLocalSourceTime', mc8TopModelsCloud: 'mc8TopModelsCloudSourceTime',
};
const idleSources = {
  mc8RequestsPerMinute: 'mc8RequestsSourceTime',
  mc8RequestLatencyLocalP50: 'mc8RequestLatencyLocalSourceTime', mc8RequestLatencyLocalP95: 'mc8RequestLatencyLocalSourceTime',
  mc8RequestLatencyCloudP50: 'mc8RequestLatencyCloudSourceTime', mc8RequestLatencyCloudP95: 'mc8RequestLatencyCloudSourceTime',
  mc8Failures15m: 'mc8Failures15mSourceTime', mc8Fallbacks15m: 'mc8Fallbacks15mSourceTime',
  mc8TopModelsLocal: 'mc8TopModelsLocalSourceTime', mc8TopModelsCloud: 'mc8TopModelsCloudSourceTime',
};
const liveIdleKeys = new Set(['mc8RequestsPerMinute', 'mc8RequestLatencyLocalP50', 'mc8RequestLatencyLocalP95',
  'mc8RequestLatencyCloudP50', 'mc8RequestLatencyCloudP95', 'mc8Failures15m', 'mc8Fallbacks15m', 'mc8TopModelsLocal', 'mc8TopModelsCloud']);
let shaped = shapeRates([], []), displayed = { callers: [], models: [], routes: [], hidden: [] }, insightErrors = {}, pins = pinRules([]);

function age(at) {
  if (at == null) return 'STALE: measurement time unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 300 ? `STALE ${seconds}s` : `STALE since ${new Date(at).toLocaleTimeString()}`;
}

function stateText(keys) {
  const sources = keys.map((key) => feeds[key]);
  if (sources.some((s) => !s || s.state === 'pending')) return 'Pending: no measurements yet';
  const stale = sources.filter((s) => !fresh(s));
  return stale.length ? age(stale.some((s) => s.at == null) ? null : Math.min(...stale.map((s) => s.at))) : 'Live';
}

function reading(id, keys, value, unit, caption, missing = 'Pending') {
  const panel = $(id).closest('[data-panel]');
  const state = stateText(keys);
  if (value == null && keys.every((key) => feeds[key]?.state === 'idle')) {
    panel.dataset.state = 'ok';
    $(id).textContent = 'Idle';
    panel.querySelector('.status').textContent = 'Idle · no samples in the trailing 5 minutes';
    return;
  }
  const stale = state.startsWith('STALE');
  panel.dataset.state = state.startsWith('Pending') || (value == null && !stale) ? 'pending' : stale ? 'stale' : 'ok';
  // A held empty reading (a measured zero or idle, then a failed poll) reads Stale. A reading never measured,
  // or a share that cannot be computed, shows its fallback; the panel status carries any staleness.
  const held = keys.some((key) => feeds[key]?.at != null);
  $(id).textContent = value == null ? (stale && held && missing === 'Pending' ? 'Stale' : missing)
    : typeof value === 'string' ? value : `${number(value)}${unit}`;
  panel.querySelector('.status').textContent = value == null && missing === 'Pending' && !stale ? 'No measurements yet' : state === 'Live' ? caption : state;
}

function updateUnclassified() {
  const id = $('unclassified-share');
  const state = shareState(feeds.mc8InputRate, feeds.mc8OutputRate);
  id.dataset.state = state;
  if (shaped.unclassifiedShare == null) {
    id.textContent = '';
    return;
  }
  const status = state === 'ok' ? '' : ` · ${stateText(['mc8InputRate', 'mc8OutputRate'])}`;
  id.textContent = `unclassified cloud ${number(shaped.unclassifiedShare)}%${status}`;
}

function render() {
  const ready = ['mc8InputRate', 'mc8OutputRate'].every((key) => feeds[key]?.rows.length);
  shaped = ready ? shapeRates(groupCallerRows(feeds.mc8InputRate.rows, pins), groupCallerRows(feeds.mc8OutputRate.rows, pins)) : shapeRates([], []);
  shaped.callers = pinCallers(shaped.callers, pins.names);
  for (const key of ['mc8Failures', 'mc8Fallbacks']) {
    for (const row of feeds[key]?.rows || []) {
      const metricId = modelKey(row.labels);
      if (!increased(feeds[key], metricId) || shaped.models.some((m) => m.metricId === metricId)) continue;
      shaped.models.push({ id: metricId, metricId, name: row.labels.model || 'Unlabelled model',
        provider: row.labels.api_provider || 'unknown', bank: 'unknown', rate: null });
    }
  }
  const scalar = (key) => feedValue(feeds[key]);
  reading('local-rate', ['mc8InputRate', 'mc8OutputRate'], shaped.localRate, ' t/s', 'Local input + output tokens per second', ready ? 'Unavailable' : 'Pending');
  updateUnclassified();
  const inFlight = splitInFlight(feeds.mc8InFlight?.rows, feeds.vllmRunning?.rows, feeds.llamaRunning?.rows);
  reading('in-flight', IN_FLIGHT_KEYS, classPair(inFlight.local, inFlight.cloud), '', 'Local engines plus the router remainder');
  reading('spend', ['mc8SpendCents'], scalar('mc8SpendCents'), '¢', 'OpenRouter · month to date · UTC');
  const localTtft = scalar('mc8TtftLocalP95'), cloudTtft = scalar('mc8TtftCloudP95');
  reading('ttft', TTFT_KEYS, classPair(localTtft == null ? null : localTtft * 1000,
    cloudTtft == null ? null : cloudTtft * 1000, ' ms'), '', 'Router histogram · trailing 5 minutes');
  board.dataset.state = !ready ? 'pending' : stateText(['mc8InputRate', 'mc8OutputRate']).startsWith('STALE') ? 'stale' : 'ok';
  $('route-state').textContent = !ready ? 'Pending token rates' : `${classPair(shaped.localRate, shaped.cloudRate)} tokens/s`;
  const callers = $('callers'), models = $('models');
  const callerSplit = fitRows(callers, shaped.callers, (split) => callerMarkup(split, displayed));
  const collapsed = (split) => shaped.models.filter((model) => !split.visible.includes(model));
  const modelSplit = fitRows(models, shaped.models, (split) => modelMarkup(split, displayed), (split) => markModels(collapsed(split)));
  displayed.callers = [...callerSplit.visible, ...(callerSplit.more ? [moreTerminal('callers', callerSplit.more)] : [])];
  displayed.models = [...modelSplit.visible, ...(modelSplit.more ? [moreTerminal('models', modelSplit.more)] : [])];
  displayed.hidden = collapsed(modelSplit);
  displayed.routes = compactRoutes(shaped.routes, displayed.callers, displayed.models);
  callers.innerHTML = callerMarkup(callerSplit, displayed);
  models.innerHTML = modelMarkup(modelSplit, displayed);
  updateStatus();
  wireDrawer.update(feeds, displayed);
}

// A "+N more" row carries the markers of the models collapsed into it.
function markModels(hidden) {
  for (const node of document.querySelectorAll('[data-kind="model"]')) {
    const more = node.classList.contains('more');
    const models = more ? hidden : shaped.models.filter((m) => m.id === node.dataset.id);
    const failedModel = models.find((m) => increased(feeds.mc8Failures, m.metricId));
    const fallbackModel = models.find((m) => increased(feeds.mc8Fallbacks, m.metricId));
    const failed = Boolean(failedModel), fallback = Boolean(fallbackModel);
    const failureText = failed ? `Failures · ${windowLabel(windowAge(feeds.mc8Failures, failedModel.metricId))}` : '';
    const fallbackText = fallback ? `Failed fallback · ${windowLabel(windowAge(feeds.mc8Fallbacks, fallbackModel.metricId))}` : '';
    const marker = node.querySelector('.failure-marker');
    marker.textContent = more ? [failureText, fallbackText].filter(Boolean).join(' · ') : failureText || fallbackText;
    marker.classList.toggle('failure', failed);
    marker.classList.toggle('fallback', !failed && fallback);
  }
}

function updateStatus() {
  $('clock').textContent = new Date().toLocaleTimeString();
  renderInsights(feeds, insightErrors);
  $('flow-status').textContent = stateText(['mc8InputRate', 'mc8OutputRate']);
  const state = stateText(['mc8Failures', 'mc8Fallbacks']);
  $('failure-status').textContent = state === 'Live' ? 'Failure flashes: increases in the last minute' : `Failure telemetry: ${state}`;
  updateUnclassified();
  board.dataset.state = !shaped.routes.length ? 'pending' : stateText(['mc8InputRate', 'mc8OutputRate']).startsWith('STALE') ? 'stale' : 'ok';
  markModels(displayed.hidden);
  for (const [id, keys] of [['local-rate', ['mc8InputRate', 'mc8OutputRate']], ['in-flight', IN_FLIGHT_KEYS], ['spend', ['mc8SpendCents']], ['ttft', TTFT_KEYS]]) {
    const panel = $(id).closest('[data-panel]');
    if (panel.dataset.state !== 'pending' && stateText(keys).startsWith('STALE')) {
      panel.dataset.state = 'stale';
      $(id).nextElementSibling.textContent = stateText(keys);
    }
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const results = await Promise.allSettled(keys.map((key) => bounded(query(Q[key], { timestamps: true }))));
    const rows = new Map(keys.map((key, i) => [key, results[i].status === 'fulfilled' ? results[i].value : null]));
    insightErrors = Object.fromEntries(keys.map((key, i) => [key, results[i].status === 'rejected'
      ? (results[i].reason?.message || 'Query failed') : rows.get(key) === null ? 'Request timed out' : null]).filter(([, message]) => message));
    const now = Date.now();
    const liveAt = Number(rows.get('mc8InFlightSourceTime')?.[0]?.value) * 1000;
    for (const key of feedKeys) {
      const result = rows.get(key);
      const clean = key.startsWith('mc8TopModels') && result ? result.filter((row) => row.value > 0) : result;
      const timed = clean && sourceTimes[key] ? withSourceTimes(clean, rows.get(sourceTimes[key])) : clean;
      const sourceRows = rows.get(idleSources[key] || (IDLE_WHEN_EMPTY.has(key) ? sourceTimes[key] : ''));
      const times = (sourceRows || []).map((row) => Number(row.value) * 1000).filter((at) => Number.isFinite(at) && at > 0);
      const idleAt = times.length ? Math.min(...times) : IDLE_WHEN_EMPTY.has(key) || liveIdleKeys.has(key) ? liveAt : null;
      feeds[key] = retain(feeds[key], timed, now, { emptyIsZero: ZERO_WHEN_EMPTY.has(key), liveAt, idleAt });
    }
    render();
  } finally { refreshing = false; }
}

const observer = new ResizeObserver(render);
observer.observe($('diagram'));
onDispose(() => observer.disconnect());
render();
document.fonts.ready.then(render);
signalReady();
loop(30, (now) => { if (!motion.matches) wireDrawer.draw(now); });
const clock = setInterval(updateStatus, 1000);
onDispose(() => clearInterval(clock));
let configTimer = null;
onDispose(() => clearTimeout(configTimer));
// A timed-out config request retries after the same bound; a rejected one starts with defaults.
async function start() {
  const cfg = await bounded(loadConfig()).catch(() => ({}));
  if (cfg == null) { configTimer = setTimeout(start, REQUEST_TIMEOUT_MS); return; }
  pins = pinRules(Array.isArray(cfg.mc8PinnedCallers) ? cfg.mc8PinnedCallers : []);
  render();
  const poll = setInterval(refresh, refreshMs(cfg));
  onDispose(() => clearInterval(poll));
  await refresh();
}
start();
