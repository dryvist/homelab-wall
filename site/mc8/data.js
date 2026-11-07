// Shape measured token rates only. Empty inputs and non-finite samples never become zeros.
export const BANKS = {
  local: { title: 'Local engines', color: '#76cddd' },
  subscription: { title: 'Subscriptions', color: '#b8a5ed' },
  paid: { title: 'Pay per token', color: '#edbf6c' },
  free: { title: 'Free', color: '#9ec9aa' },
  unknown: { title: 'Unclassified', color: '#aebbc9' },
};

export function providerClass(labels) {
  for (const bank of ['local', 'subscription', 'paid', 'free']) {
    if (labels[`tag_telemetry_billing_class_${bank}`] === 'true') return bank;
  }
  return 'unknown';
}

export const modelKey = (labels) => JSON.stringify([labels.model || 'Unlabelled model', labels.api_provider || 'unknown']);
export const validRows = (rows) => (rows || []).filter((r) => Number.isFinite(r.value) && r.value >= 0);

// Keep the highest-rate rows and summarize everything else in one visible row. maxRows includes
// that summary row when one is needed.
export function splitTopByRate(rows, maxRows) {
  const ranked = [...(rows || [])].sort((a, b) => {
    const rateA = Number.isFinite(a.rate) ? a.rate : -Infinity;
    const rateB = Number.isFinite(b.rate) ? b.rate : -Infinity;
    return rateB - rateA || String(a.id).localeCompare(String(b.id));
  });
  const limit = Math.max(1, Math.floor(Number.isFinite(maxRows) ? maxRows : 1));
  if (ranked.length <= limit) return { visible: ranked, more: null };
  const visible = ranked.slice(0, limit - 1);
  const hidden = ranked.slice(visible.length);
  const measured = hidden.filter((row) => Number.isFinite(row.rate));
  return {
    visible,
    more: {
      count: hidden.length,
      rate: measured.length ? measured.reduce((sum, row) => sum + row.rate, 0) : null,
    },
  };
}

const labelKey = (labels) => JSON.stringify(Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b)));

// Source-time queries return each raw series' last sample time as their value. It lands in
// sourceTime; timestamp keeps the query's evaluation time, which the failure window label needs.
export function withSourceTimes(rows, sourceRows) {
  const times = new Map((sourceRows || []).map((row) => [labelKey(row.labels), row.value]));
  return rows.map((row) => ({ ...row, sourceTime: times.get(labelKey(row.labels)) }));
}

export function shapeRates(input, output) {
  const callers = new Map(), models = new Map(), routes = new Map();
  for (const row of [...validRows(input), ...validRows(output)]) {
    const { api_key_alias: alias, team, model, api_provider: provider } = row.labels;
    const callerId = JSON.stringify([alias || '', team || '']);
    const bank = providerClass(row.labels);
    const modelId = JSON.stringify([modelKey(row.labels), bank]);
    if (!callers.has(callerId)) callers.set(callerId, {
      id: callerId, name: alias || team || 'Unattributed caller', team: alias ? team : '', rate: 0,
    });
    if (!models.has(modelId)) models.set(modelId, {
      id: modelId, name: model || 'Unlabelled model', provider: provider || 'unknown',
      bank, metricId: modelKey(row.labels), rate: 0,
    });
    const id = JSON.stringify([callerId, modelId]);
    if (!routes.has(id)) routes.set(id, { id, caller: callerId, model: modelId, rate: 0 });
    callers.get(callerId).rate += row.value;
    models.get(modelId).rate += row.value;
    routes.get(id).rate += row.value;
  }
  const sorted = (map) => [...map.values()].sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id));
  const total = [...models.values()].reduce((s, m) => s + m.rate, 0);
  const local = [...models.values()].filter((m) => m.bank === 'local').reduce((s, m) => s + m.rate, 0);
  const unknown = [...models.values()].filter((m) => m.bank === 'unknown').reduce((s, m) => s + m.rate, 0);
  const classified = [...models.values()].filter((m) => m.bank !== 'unknown').reduce((s, m) => s + m.rate, 0);
  return { callers: sorted(callers), models: sorted(models), routes: [...routes.values()], total,
    localShare: classified > 0 ? 100 * local / classified : null,
    unclassifiedShare: total > 0 ? 100 * unknown / total : null };
}

const FRESH_MS = 300000;
// The store rounds evaluation time up to a whole second and client clocks skew, so a sample up to
// 5 s ahead of browser time is accepted and clamped to now. Further ahead, missing or non-positive
// times are unusable.
const usable = (ms, now) => Number.isFinite(ms) && ms > 0 && ms <= now + 5000;
const sampleMs = (row) => ('sourceTime' in row ? row.sourceTime : row.timestamp) * 1000;
function sourceAt(rows, now) {
  const times = rows.map(sampleMs);
  return times.every((ms) => usable(ms, now)) ? Math.min(...times.map((ms) => Math.min(ms, now))) : null;
}

// A failed poll (null) keeps last-good rows and their time, stale. A poll whose samples are all non-finite
// is idle while its source is fresh: zero requests make a p95 NaN. The store drops NaN, so a successful
// empty poll is idle too while the key's own source time, idleAt in ms, is fresh. A successful empty poll
// is zero only when emptyIsZero (failure counters and spend) and router liveness, liveAt in ms, is fresh;
// otherwise it is stale. Other empty polls hold last-good rows, since no sample is no measurement.
export function retain(previous, rows, now, { emptyIsZero = false, liveAt = null, idleAt = null } = {}) {
  const clean = validRows(rows);
  if (clean.length) {
    const at = sourceAt(clean, now);
    return { rows: clean, at, state: at != null && now - at <= FRESH_MS ? 'ok' : 'stale' };
  }
  const at = rows?.length ? sourceAt(rows, now) : null;
  if (at != null && now - at <= FRESH_MS) return { rows: [], at, state: 'idle' };
  if (Array.isArray(rows) && !rows.length && usable(idleAt, now) && now - idleAt <= FRESH_MS) {
    return { rows: [], at: Math.min(idleAt, now), state: 'idle' };
  }
  if (Array.isArray(rows) && emptyIsZero && usable(liveAt, now) && now - liveAt <= FRESH_MS) return { rows: [], at: now, state: 'ok' };
  if (previous?.rows.length || previous?.at != null || previous?.state === 'stale') return { ...previous, state: 'stale' };
  if (at != null || (Array.isArray(rows) && emptyIsZero)) return { rows: [], at, state: 'stale' };
  return { rows: [], at: null, state: 'pending' };
}

// A successful empty poll of these keys means zero while router liveness (the in-flight source time) is fresh:
// no failures, or no OpenRouter spend, since provider series exist only after use. Empty rate or latency polls
// stay unmeasured.
export const ZERO_WHEN_EMPTY = new Set(['mc8Failures', 'mc8Fallbacks', 'mc8SpendCents']);
// A successful empty poll of these percentiles is idle while their own histogram source time is fresh.
export const IDLE_WHEN_EMPTY = new Set(['mc8TtftP95']);
// A feed's single value: its first row, zero for a fresh empty zero-when-empty poll, otherwise null.
export const feedValue = (feed) => (feed?.state === 'ok' && !feed.rows.length ? 0 : feed?.rows[0]?.value ?? null);

export const fresh = (feed, now = Date.now()) => ['ok', 'idle'].includes(feed?.state)
  && feed.at != null && now - feed.at <= FRESH_MS;

export const shareState = (input, output, now = Date.now()) => {
  if (!input?.rows.length || !output?.rows.length) return 'pending';
  return fresh(input, now) && fresh(output, now) ? 'ok' : 'stale';
};

// Increase results cover [T-1m, T] where T is the query evaluation timestamp of the matching row. The
// feed's source time decides freshness only.
export const increased = (feed, model, now = Date.now()) => {
  const row = feed?.rows.find((r) => modelKey(r.labels) === model && r.value > 0);
  return fresh(feed, now) && Number.isFinite(row?.timestamp) && now <= row.timestamp * 1000 + 75000;
};

// Seconds since the one-minute window behind a positive increase ended at its evaluation time T.
export function windowAge(feed, model, now = Date.now()) {
  const row = feed?.rows.find((r) => modelKey(r.labels) === model && r.value > 0);
  return Number.isFinite(row?.timestamp) ? Math.max(0, Math.round(now / 1000 - row.timestamp)) : null;
}

// One 15 s poll plus the 10 s request bound: a flash whose window ended longer ago names that window's age.
export const windowLabel = (age) => age == null || age <= 25 ? 'last minute' : `window ended ${age}s ago`;

// Poll interval from /config.json: 15 s when missing or invalid, otherwise at least 1 s (as MC7).
export function refreshMs(config) {
  const seconds = Number(config?.refreshSeconds);
  return (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, seconds) : 15) * 1000;
}

// Each poll request races this bound; a hung request resolves null, which retain() treats as a failed poll.
export const REQUEST_TIMEOUT_MS = 10_000;
export function bounded(request, ms = REQUEST_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    request,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}
