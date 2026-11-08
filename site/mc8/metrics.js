import { fresh, providerClass } from './data.js';

const valueRows = (feed) => feed?.rows || [];
const measured = (feed) => Boolean(feed && (feed.rows?.length || feed.at != null));
const number = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function formatPair(local, cloud, unit = '') {
  const values = [];
  if (Number.isFinite(local)) values.push(`local ${number(local)}${unit}`);
  if (Number.isFinite(cloud)) values.push(`cloud ${number(cloud)}${unit}`);
  return values.join(' · ') || '—';
}

export function classTotals(rows) {
  let local = null, cloud = null;
  for (const row of rows || []) {
    if (!Number.isFinite(row.value) || row.value < 0) continue;
    const key = row.labels?.tag_telemetry_billing_class_local === 'true' ? 'local' : 'cloud';
    if (key === 'local') local = (local ?? 0) + row.value;
    else cloud = (cloud ?? 0) + row.value;
  }
  return { local, cloud };
}

// Config pins: an alias string, or { name, match } where match is a glob (`*` wildcard). Callers a glob matches
// share one row under its name; an alias pinned by its exact name keeps its own row.
export function pinRules(pins) {
  const exact = new Set(), groups = [];
  for (const pin of pins || []) {
    if (typeof pin === 'string' && pin) exact.add(pin);
    else if (pin && typeof pin.name === 'string' && pin.name && typeof pin.match === 'string' && pin.match) {
      const body = pin.match.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      groups.push({ name: pin.name, re: new RegExp(`^${body}$`) });
    }
  }
  return { exact, groups, names: [...exact, ...groups.map((group) => group.name)] };
}

export function groupCallerRows(rows, rules) {
  if (!rules?.groups.length) return rows || [];
  return (rows || []).map((row) => {
    const alias = row.labels?.api_key_alias;
    if (typeof alias !== 'string' || rules.exact.has(alias)) return row;
    const group = rules.groups.find((candidate) => candidate.re.test(alias));
    return group ? { ...row, labels: { ...row.labels, api_key_alias: group.name, team: '' } } : row;
  });
}

export function pinCallers(callers, aliases) {
  const result = [...(callers || [])];
  for (const alias of new Set((aliases || []).filter((value) => typeof value === 'string' && value.length))) {
    const caller = result.find((item) => {
      try { return JSON.parse(item.id)[0] === alias; } catch { return item.name === alias; }
    });
    if (caller) caller.pinned = true;
    else result.push({ id: JSON.stringify([alias, '']), name: alias, team: '', localRate: null, cloudRate: null, pinned: true });
  }
  return result;
}

export function topModels(rows, limit = 5) {
  const result = { local: new Map(), cloud: new Map() };
  for (const row of rows || []) {
    if (!Number.isFinite(row.value) || row.value <= 0 || !row.labels?.model) continue;
    const group = result[providerClass(row.labels) === 'local' ? 'local' : 'cloud'];
    group.set(row.labels.model, (group.get(row.labels.model) || 0) + row.value);
  }
  for (const key of Object.keys(result)) {
    result[key] = [...result[key]].map(([name, requests]) => ({ name, requests })).sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
    const group = result[key];
    group.splice(Math.max(0, Math.floor(limit)));
  }
  return result;
}

function age(feed, now) {
  if (feed?.at == null) return 'STALE: measurement time unavailable';
  const seconds = Math.max(0, Math.floor((now - feed.at) / 1000));
  return seconds < 300 ? `STALE ${seconds}s` : `STALE since ${new Date(feed.at).toLocaleTimeString()}`;
}

export function insightStatus(queryKeys, valueKeys, feeds, errors = {}, now = Date.now()) {
  const failed = queryKeys.map((key) => errors[key]).filter(Boolean);
  const values = valueKeys.map((key) => feeds[key]);
  const observed = values.filter(measured);
  if (failed.length) {
    const message = failed[0];
    return values.some((feed) => feed?.rows?.length)
      ? { state: 'stale', text: `${age(observed.reduce((oldest, feed) => feed.at < oldest.at ? feed : oldest), now)} · Error: ${message}` }
      : { state: 'error', text: `Error: ${message}` };
  }
  const stale = observed.filter((feed) => !fresh(feed, now));
  if (stale.length) return { state: 'stale', text: age(stale.reduce((oldest, feed) => feed.at < oldest.at ? feed : oldest), now) };
  if (values.length && values.every((feed) => feed?.state === 'idle')) return { state: 'idle', text: 'Idle · source fresh, no samples' };
  if (values.some((feed) => feed?.state === 'ok' || feed?.state === 'idle')) return { state: 'ok', text: 'Live · trailing window' };
  if (values.some((feed) => feed?.state === 'pending')) return { state: 'pending', text: 'Pending: no measurements yet' };
  return { state: 'pending', text: 'Pending: no measurements yet' };
}

function renderPanel(id, queryKeys, valueKeys, feeds, errors, now, caption) {
  const panel = document.querySelector(`[data-insight="${id}"]`);
  const state = insightStatus(queryKeys, valueKeys, feeds, errors, now);
  panel.dataset.state = state.state;
  panel.querySelector('.insight-status').textContent = state.state === 'ok' ? caption : state.text;
  return panel;
}

function metricValue(feed) {
  return feed?.rows.find((row) => Number.isFinite(row.value))?.value ?? null;
}

export function renderInsights(feeds, errors = {}, now = Date.now()) {
  const requests = classTotals(valueRows(feeds.mc8RequestsPerMinute));
  renderPanel('requests', ['mc8RequestsPerMinute', 'mc8RequestsSourceTime'], ['mc8RequestsPerMinute'], feeds, errors, now, 'Router counter · trailing 5 minutes');
  document.getElementById('requests-value').textContent = formatPair(requests.local, requests.cloud, ' req/min');

  const latencyKeys = ['mc8RequestLatencyLocalP50', 'mc8RequestLatencyCloudP50', 'mc8RequestLatencyLocalP95', 'mc8RequestLatencyCloudP95'];
  const latencySources = ['mc8RequestLatencyLocalSourceTime', 'mc8RequestLatencyCloudSourceTime'];
  renderPanel('latency', [...latencyKeys, ...latencySources], latencyKeys, feeds, errors, now, 'Router histogram · trailing 5 minutes');
  // The router latency histogram is in seconds.
  const ms = (feed) => { const value = metricValue(feed); return value == null ? null : value * 1000; };
  const latency = (percentile) => formatPair(
    ms(feeds[`mc8RequestLatencyLocalP${percentile}`]),
    ms(feeds[`mc8RequestLatencyCloudP${percentile}`]), ' ms');
  document.getElementById('latency-value').textContent = `p50  ${latency(50)}\np95  ${latency(95)}`;

  const outcomeKeys = ['mc8Failures15m', 'mc8Fallbacks15m'];
  const outcomeSources = ['mc8Failures15mSourceTime', 'mc8Fallbacks15mSourceTime'];
  renderPanel('outcomes', [...outcomeKeys, ...outcomeSources], outcomeKeys, feeds, errors, now, 'Router counters · trailing 15 minutes');
  const failures = classTotals(valueRows(feeds.mc8Failures15m));
  const fallbacks = classTotals(valueRows(feeds.mc8Fallbacks15m));
  document.getElementById('outcomes-value').textContent = `Failures  ${formatPair(failures.local, failures.cloud)}\nFallbacks  ${formatPair(fallbacks.local, fallbacks.cloud)}`;

  const topKeys = ['mc8TopModelsLocal', 'mc8TopModelsCloud'];
  const topSources = ['mc8TopModelsLocalSourceTime', 'mc8TopModelsCloudSourceTime'];
  const panel = renderPanel('top-models', [...topKeys, ...topSources], topKeys, feeds, errors, now, 'Router histogram · trailing 1 hour');
  const groups = topModels(topKeys.flatMap((key) => valueRows(feeds[key])));
  const list = panel.querySelector('#top-models-value');
  list.replaceChildren();
  const visible = ['local', 'cloud'].filter((bank) => groups[bank].length);
  for (const bank of visible) {
    const group = document.createElement('section');
    group.className = `top-model-group ${bank}`;
    const heading = document.createElement('h4');
    heading.textContent = bank === 'local' ? 'Local' : 'Cloud';
    group.append(heading);
    for (const model of groups[bank]) {
      const item = document.createElement('p');
      item.textContent = `${model.name} · ${number(model.requests)} req`;
      group.append(item);
    }
    list.append(group);
  }
  if (!visible.length) list.textContent = panel.dataset.state === 'idle' ? 'No requests in the last hour' : panel.dataset.state === 'pending' ? 'Pending' : 'No model counts';
}
