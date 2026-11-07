import { query } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { esc, loop, onDispose, adaptiveDpr, loadConfig, signalReady } from '/lib/stage.js';
import { BANKS, shapeRates, splitTopByRate, retain, modelKey, fresh, shareState, withSourceTimes, increased, bounded, windowAge, windowLabel, refreshMs, REQUEST_TIMEOUT_MS, ZERO_WHEN_EMPTY, IDLE_WHEN_EMPTY, feedValue } from './data.js';

const $ = (id) => document.getElementById(id);
const board = $('switchboard'), canvas = $('wires'), ctx = canvas.getContext('2d');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const number = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const feeds = {};
const keys = ['mc8InputRate', 'mc8OutputRate', 'mc8InputSourceTime', 'mc8OutputSourceTime', 'mc8InFlight', 'mc8SpendCents', 'mc8TtftP95', 'mc8Failures', 'mc8Fallbacks',
  'mc8InFlightSourceTime', 'mc8SpendSourceTime', 'mc8TtftSourceTime', 'mc8FailuresSourceTime', 'mc8FallbacksSourceTime'];
const feedKeys = keys.filter((key) => !key.endsWith('SourceTime'));
const sourceTimes = {
  mc8InputRate: 'mc8InputSourceTime', mc8OutputRate: 'mc8OutputSourceTime', mc8InFlight: 'mc8InFlightSourceTime',
  mc8SpendCents: 'mc8SpendSourceTime', mc8TtftP95: 'mc8TtftSourceTime', mc8Failures: 'mc8FailuresSourceTime', mc8Fallbacks: 'mc8FallbacksSourceTime',
};
let shaped = shapeRates([], []), displayed = { callers: [], models: [], routes: [], hidden: [] }, wires = [], selected = null;

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
  $(id).textContent = value == null ? (stale && held && missing === 'Pending' ? 'Stale' : missing) : `${number(value)}${unit}`;
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
  id.textContent = `unclassified ${number(shaped.unclassifiedShare)}%${status}`;
}

function moreTerminal(kind, more) {
  return { id: `__more_${kind}__`, name: `+${more.count} more`, rate: more.rate, more: true, bank: 'unknown', metricId: null };
}

function callerMarkup(split) {
  const rows = [...split.visible, ...(split.more ? [moreTerminal('callers', split.more)] : [])];
  return rows.length ? rows.map((caller) => terminal(caller, 'caller')).join('') : '<p class="no-feed">No caller rates yet</p>';
}

function modelMarkup(split) {
  const groups = Object.entries(BANKS).map(([bank, style]) => {
    const models = split.visible.filter((model) => model.bank === bank);
    return models.length
      ? `<section class="bank" style="--bank:${style.color}"><h3>${style.title}</h3>${models.map((model) => terminal(model, 'model')).join('')}</section>`
      : '';
  }).join('');
  const more = split.more ? terminal(moreTerminal('models', split.more), 'model') : '';
  return groups + more || '<p class="no-feed">No measured routes</p>';
}

// Render candidate splits and use the column's real scroll box to find the largest one that fits.
function fitRows(container, rows, markup, mark = () => {}) {
  if (!rows.length) {
    const split = splitTopByRate(rows, 1);
    container.innerHTML = markup(split);
    return split;
  }
  let best = null;
  let low = 1, high = rows.length;
  while (low <= high) {
    const limit = Math.floor((low + high) / 2);
    const split = splitTopByRate(rows, limit);
    container.innerHTML = markup(split);
    mark(split);
    if (container.scrollHeight <= container.clientHeight) {
      best = split;
      low = limit + 1;
    } else {
      high = limit - 1;
    }
  }
  const split = best || splitTopByRate(rows, 1);
  container.innerHTML = markup(split);
  return split;
}

function compactRoutes(routes, callers, models) {
  const callerIds = new Set(callers.map((caller) => caller.id));
  const modelIds = new Set(models.map((model) => model.id));
  const moreCaller = callers.find((caller) => caller.more)?.id;
  const moreModel = models.find((model) => model.more)?.id;
  const compacted = new Map();
  for (const route of routes) {
    const caller = callerIds.has(route.caller) ? route.caller : moreCaller;
    const model = modelIds.has(route.model) ? route.model : moreModel;
    if (!caller || !model) continue;
    const id = JSON.stringify([caller, model]);
    const current = compacted.get(id);
    if (current) current.rate += route.rate;
    else compacted.set(id, { id, caller, model, rate: route.rate });
  }
  return [...compacted.values()];
}

function render() {
  const ready = ['mc8InputRate', 'mc8OutputRate'].every((key) => feeds[key]?.rows.length);
  shaped = ready ? shapeRates(feeds.mc8InputRate.rows, feeds.mc8OutputRate.rows) : shapeRates([], []);
  for (const key of ['mc8Failures', 'mc8Fallbacks']) {
    for (const row of feeds[key]?.rows || []) {
      const metricId = modelKey(row.labels);
      if (!increased(feeds[key], metricId) || shaped.models.some((m) => m.metricId === metricId)) continue;
      shaped.models.push({ id: metricId, metricId, name: row.labels.model || 'Unlabelled model',
        provider: row.labels.api_provider || 'unknown', bank: 'unknown', rate: null });
    }
  }
  const scalar = (key) => feedValue(feeds[key]);
  reading('local-share', ['mc8InputRate', 'mc8OutputRate'], shaped.localShare, '%', 'Share of classified input + output tokens', ready ? 'Unavailable' : 'Pending');
  updateUnclassified();
  reading('in-flight', ['mc8InFlight'], scalar('mc8InFlight'), '', 'Requests across the router');
  reading('spend', ['mc8SpendCents'], scalar('mc8SpendCents'), '¢', 'OpenRouter · month to date · UTC');
  reading('ttft', ['mc8TtftP95'], scalar('mc8TtftP95') == null ? null : scalar('mc8TtftP95') * 1000, ' ms', 'Router histogram · trailing 5 minutes');
  board.dataset.state = !ready ? 'pending' : stateText(['mc8InputRate', 'mc8OutputRate']).startsWith('STALE') ? 'stale' : 'ok';
  $('route-state').textContent = !ready ? 'Pending token rates' : shaped.total === 0 ? 'Idle' : `${number(shaped.total)} tokens/s`;
  const callers = $('callers'), models = $('models');
  const callerSplit = fitRows(callers, shaped.callers, callerMarkup);
  const collapsed = (split) => shaped.models.filter((model) => !split.visible.includes(model));
  const modelSplit = fitRows(models, shaped.models, modelMarkup, (split) => markModels(collapsed(split)));
  displayed.callers = [...callerSplit.visible, ...(callerSplit.more ? [moreTerminal('callers', callerSplit.more)] : [])];
  displayed.models = [...modelSplit.visible, ...(modelSplit.more ? [moreTerminal('models', modelSplit.more)] : [])];
  displayed.hidden = collapsed(modelSplit);
  displayed.routes = compactRoutes(shaped.routes, displayed.callers, displayed.models);
  callers.innerHTML = callerMarkup(callerSplit);
  models.innerHTML = modelMarkup(modelSplit);
  updateStatus();
  measure();
}

function terminal(node, kind) {
  const destinations = displayed.routes.filter((r) => kind === 'caller' ? r.caller === node.id : r.model === node.id).map((r) => {
    const other = (kind === 'caller' ? displayed.models : displayed.callers).find((n) => n.id === (kind === 'caller' ? r.model : r.caller));
    return `${other.name}: ${number(r.rate)} tokens/s`;
  }).join('; ');
  return `<div class="terminal${node.more ? ' more' : ''}" tabindex="0" data-kind="${kind}" data-id="${esc(node.id)}" title="${esc(destinations)}"><div><strong>${esc(node.name)}</strong>${node.team ? `<small>${esc(node.team)}</small>` : ''}${kind === 'model' ? '<small class="failure-marker"></small>' : ''}</div><span class="rate">${node.rate == null ? 'No token rate' : `${number(node.rate)} t/s`}</span></div>`;
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
  $('flow-status').textContent = stateText(['mc8InputRate', 'mc8OutputRate']);
  const state = stateText(['mc8Failures', 'mc8Fallbacks']);
  $('failure-status').textContent = state === 'Live' ? 'Failure flashes: increases in the last minute' : `Failure telemetry: ${state}`;
  updateUnclassified();
  board.dataset.state = !shaped.routes.length ? 'pending' : stateText(['mc8InputRate', 'mc8OutputRate']).startsWith('STALE') ? 'stale' : 'ok';
  markModels(displayed.hidden);
  for (const [id, keys] of [['local-share', ['mc8InputRate', 'mc8OutputRate']], ['in-flight', ['mc8InFlight']], ['spend', ['mc8SpendCents']], ['ttft', ['mc8TtftP95']]]) {
    const panel = $(id).closest('[data-panel]');
    if (panel.dataset.state !== 'pending' && stateText(keys).startsWith('STALE')) {
      panel.dataset.state = 'stale';
      $(id).nextElementSibling.textContent = stateText(keys);
    }
  }
}

function measure() {
  const box = $('diagram').getBoundingClientRect(), dpr = adaptiveDpr();
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const positions = new Map([...document.querySelectorAll('.terminal')].map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.dataset.kind + node.dataset.id, { x: (node.dataset.kind === 'caller' ? rect.right : rect.left) - box.left, y: rect.top + rect.height / 2 - box.top }];
  }));
  const hub = $('hub').getBoundingClientRect();
  wires = displayed.routes.filter((r) => r.rate > 0).map((r) => ({ ...r,
    from: positions.get('caller' + r.caller), to: positions.get('model' + r.model),
    mid: { x: hub.left + hub.width / 2 - box.left, y: hub.top + hub.height / 2 - box.top },
    color: displayed.models.find((m) => m.id === r.model)?.more ? '#9bacbf'
      : BANKS[displayed.models.find((m) => m.id === r.model)?.bank]?.color || '#9bacbf',
  }));
  draw(performance.now());
}

function draw(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const maximum = Math.max(...wires.map((w) => w.rate), 1);
  for (const wire of wires) {
    const { from: a, to: b, mid: c } = wire;
    if (!a || !b) continue;
    const active = !selected || wire[selected.kind] === selected.id;
    const model = displayed.models.find((m) => m.id === wire.model);
    const behind = model?.more ? displayed.hidden : model ? [model] : [];
    const failed = behind.some((m) => increased(feeds.mc8Failures, m.metricId));
    const fallback = behind.some((m) => increased(feeds.mc8Fallbacks, m.metricId));
    const flash = motion.matches || Math.floor(now / 450) % 2 === 0;
    ctx.strokeStyle = wire.color;
    ctx.globalAlpha = (active ? .65 : .06) * (board.dataset.state === 'stale' ? .35 : 1);
    ctx.lineWidth = 1 + 11 * wire.rate / maximum;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo((a.x + c.x) / 2, a.y, (a.x + c.x) / 2, c.y, c.x, c.y);
    ctx.stroke();
    if (!motion.matches && board.dataset.state === 'ok') {
      ctx.save(); ctx.lineWidth = 1.5; ctx.globalAlpha = active ? .9 : .06;
      ctx.setLineDash([4, 26]); ctx.lineDashOffset = -now / 45;
      ctx.stroke(); ctx.restore();
    }
    // Failures are attributed to models only, never inferred for a caller.
    ctx.strokeStyle = failed && flash ? '#ff7288' : fallback && flash ? '#ffb66b' : wire.color;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.bezierCurveTo((b.x + c.x) / 2, c.y, (b.x + c.x) / 2, b.y, b.x, b.y);
    ctx.stroke();
    // Moving dashes indicate direction only; width and labels encode the measured rate.
    if (!motion.matches && board.dataset.state === 'ok') {
      ctx.globalAlpha = active ? .9 : .06;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 26]);
      ctx.lineDashOffset = -now / 45;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

for (const event of ['pointerover', 'focusin']) board.addEventListener(event, (e) => {
  const node = e.target.closest('.terminal');
  selected = node ? { kind: node.dataset.kind, id: node.dataset.id } : null;
  draw(performance.now());
});
for (const event of ['pointerleave', 'focusout']) board.addEventListener(event, () => { selected = null; draw(performance.now()); });

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const results = await Promise.allSettled(keys.map((key) => bounded(query(Q[key], { timestamps: true }))));
    const rows = new Map(keys.map((key, i) => [key, results[i].status === 'fulfilled' ? results[i].value : null]));
    const now = Date.now();
    const liveAt = Number(rows.get('mc8InFlightSourceTime')?.[0]?.value) * 1000;
    for (const key of feedKeys) {
      const result = rows.get(key);
      const timed = result && sourceTimes[key] ? withSourceTimes(result, rows.get(sourceTimes[key])) : result;
      const idleAt = IDLE_WHEN_EMPTY.has(key) ? Number(rows.get(sourceTimes[key])?.[0]?.value) * 1000 : null;
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
loop(30, (now) => { if (!motion.matches) draw(now); });
const clock = setInterval(updateStatus, 1000);
onDispose(() => clearInterval(clock));
let configTimer = null;
onDispose(() => clearTimeout(configTimer));
// A timed-out config request retries after the same bound; a rejected one starts with defaults.
async function start() {
  const cfg = await bounded(loadConfig()).catch(() => ({}));
  if (cfg == null) { configTimer = setTimeout(start, REQUEST_TIMEOUT_MS); return; }
  const poll = setInterval(refresh, refreshMs(cfg));
  onDispose(() => clearInterval(poll));
  await refresh();
}
start();
