import { query, range, settle } from '../lib/prom.js';
import { Q } from '../lib/queries.js';
import { BENCHMARK_Q, BENCHMARK_SOURCE_AGE_FOR, BENCHMARK_SOURCE_AGE_Q } from '../lib/benchmarkQueries.js';
import { lastGoodGet, lastGoodSet } from '../lib/lastGood.js';

export const INSTANT_KEYS = [...Object.keys(BENCHMARK_Q), 'llmTokRate'];
export const HISTORY_KEYS = ['engineDecode', 'enginePrefill'];
export const SOURCE_AGE_KEYS = Object.keys(BENCHMARK_SOURCE_AGE_Q);
const REQUEST_TIMEOUT_MS = 10_000;

function bounded(request) {
  let timer;
  return Promise.race([
    request,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

export async function loadBenchmarks() {
  return settle({
    ...Object.fromEntries(INSTANT_KEYS.map((key) => [key, () => bounded(query(Q[key]))])),
    ...Object.fromEntries(SOURCE_AGE_KEYS.map((key) => [key, () => bounded(query(Q[key]))])),
    ...Object.fromEntries(HISTORY_KEYS.map((key) => [`${key}History`, async () => {
      const end = Math.floor(Date.now() / 1000 / 15) * 15;
      const bounds = { start: end - 600, end };
      const rows = await bounded(range(Q[key], 10, 15, { timestamps: true, align: true, bounds }));
      return rows?.map((row) => ({ ...row, ...bounds, step: 15 })) ?? null;
    }])),
  });
}

const identity = (row) => JSON.stringify(Object.entries(row.labels).sort(([a], [b]) => a.localeCompare(b)));

function retainByIdentity(current, previous = [], removed = []) {
  const rows = new Map(previous.map((row) => [identity(row), row]));
  for (const row of removed) rows.delete(identity(row));
  for (const row of current) rows.set(identity(row), row);
  return [...rows.values()];
}

const sameIdentity = (row, age) => matches(row, age.labels)
  && Object.keys(row.labels).length === Object.keys(age.labels).length;

// Any percentile is NaN when its window holds no requests.
const QUANTILE_KEY = /P\d+$/;
// A held reading unmeasured for longer than this is dropped, so retired engines and models leave the page.
const HOLD_SECONDS = 3600;

// Failed polls retain last-good instant and history readings; successful empty instant polls also
// retain values. Source ages remain separate from query evaluation timestamps so held readings go stale.
// A row takes a source time only in the poll that measured it; a held row keeps the time of its last measurement.
export function retainMeasurements(raw) {
  const data = {};
  const now = Date.now() / 1000;
  for (const key of INSTANT_KEYS) {
    const held = lastGoodGet(`mc7:${key}`);
    const heldValues = held?.value || [];
    const ageKey = BENCHMARK_SOURCE_AGE_FOR[key];
    const heldAges = lastGoodGet(`mc7:${ageKey}`)?.value || [];
    const ages = (raw[ageKey] == null ? heldAges
      : retainByIdentity(raw[ageKey].filter((row) => Number.isFinite(row.value))
        .map(({ labels, value }) => ({ labels, value })), heldAges))
      .filter((age) => now - age.value <= HOLD_SECONDS);
    if (raw[ageKey] != null) lastGoodSet(`mc7:${ageKey}`, ages);
    const freshAge = (row) => {
      const source = ages.find((age) => sameIdentity(row, age));
      return source && source.value <= now + 5 && now - source.value <= 300 ? source : null;
    };
    const quantile = QUANTILE_KEY.test(key);
    const idleRows = raw[key]?.filter((row) => quantile && Number.isNaN(row.value)
      && freshAge(row)).map((row) => ({ ...row, value: null, idle: true })) || [];
    const removed = raw[key]?.filter((row) => !Number.isFinite(row.value)
      && !(quantile && Number.isNaN(row.value) && !freshAge(row))) || [];
    const values = raw[key] == null ? heldValues
      : retainByIdentity(raw[key].filter((row) => Number.isFinite(row.value)), heldValues, removed);
    const measured = new Set((raw[key] || []).map(identity));
    // Rows stored before measuredAt existed take the time of the stored poll once.
    const heldAt = (held?.at ?? 0) / 1000;
    const stamp = (row) => {
      if (!measured.has(identity(row))) return row.measuredAt == null ? { ...row, measuredAt: heldAt } : row;
      const source = ages.find((age) => sameIdentity(row, age));
      return { ...row, sourceTimestamp: source?.value, measuredAt: now };
    };
    const retained = [...values, ...idleRows].map(stamp)
      .filter((row) => now - row.measuredAt <= HOLD_SECONDS);
    if (raw[key] != null) lastGoodSet(`mc7:${key}`, retained);
    data[key] = retained;
  }
  for (const key of HISTORY_KEYS) {
    const historyKey = `${key}History`;
    const previous = lastGoodGet(`mc7:${historyKey}`);
    const history = raw[historyKey] == null
      ? (previous?.value || []).map((row) => ({ ...row, staleSince: previous.at / 1000 }))
      : raw[historyKey];
    if (raw[historyKey] != null) lastGoodSet(`mc7:${historyKey}`, history);
    data[historyKey] = history;
  }
  return refreshFreshness({ data, failed: Object.values(raw).some((rows) => rows == null), checkedAt: Date.now() });
}

export function refreshFreshness(result) {
  const stale = new Map(), now = Date.now() / 1000;
  const data = { ...result.data };
  for (const key of INSTANT_KEYS) {
    data[key] = (data[key] || []).map((row) => {
      const timestamp = row.sourceTimestamp;
      const sourceTimestamp = Number.isFinite(timestamp) && timestamp <= now + 5
        ? Math.min(timestamp, now) : undefined;
      return sourceTimestamp === timestamp ? row : { ...row, sourceTimestamp };
    });
    const old = data[key].filter((row) => !Number.isFinite(row.sourceTimestamp)
      || now - row.sourceTimestamp > 300);
    if (old.length) stale.set(key, new Set(old));
  }
  for (const key of HISTORY_KEYS) {
    const old = (data[`${key}History`] || []).filter((row) => Number.isFinite(row.staleSince));
    if (old.length) stale.set(`${key}History`, new Set(old));
  }
  return { ...result, data, stale };
}

export const matches = (row, labels) => Object.entries(labels).every(([key, val]) => row.labels[key] === val);
export const reading = (data, key, labels) => data[key]?.find((row) => matches(row, labels))?.value;

export function identities(data, router = false) {
  const found = new Map();
  for (const key of INSTANT_KEYS.filter((key) => router ? key.startsWith('router') || key === 'llmTokRate' : key.startsWith('engine'))) {
    for (const { labels } of data[key] || []) {
      const key = !router && labels.backend === 'llamacpp' ? 'guest' : 'model';
      if (!labels[key] || (!router && !labels.backend)) continue;
      const id = router ? { model: labels.model } : { backend: labels.backend, [key]: labels[key] };
      found.set(JSON.stringify(id), id);
    }
  }
  return [...found.values()].sort((a, b) => `${a.backend || ''}/${a.guest || a.model}`.localeCompare(`${b.backend || ''}/${b.guest || b.model}`));
}
