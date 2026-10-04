// Read-only Prometheus client. Two sources, same query()/range() surface for every caller:
//   - live: the gateway (homelab-wall-feed) exposes GET /api/prom/query and /api/prom/query_range
//     on the wall's own origin (internal deployments; passes arbitrary PromQL, stays internal-only).
//   - snapshot: when /config.json sets "snapshot": "<path>", results come from one JSON polled
//     every 2s instead (public deployment — nothing reaches into the home network at request time).
// Callers always pass a site/lib/queries.js Q.* expression; the Q keys are the snapshot's own
// contract (scripts/gen-queries.mjs emits the same key set the publisher's allow-list is built
// from), so the expression is mapped back to its key here rather than changing every call site.
import { Q } from './queries.js';

const BASE = '/api/prom';
const SNAPSHOT_TTL_MS = 2000;
const EXPR_TO_KEY = new Map(Object.entries(Q).map(([key, expr]) => [expr, key]));

function keyFor(expr) {
  const key = EXPR_TO_KEY.get(expr);
  if (!key) throw new Error(`query not in site/lib/queries.js Q: ${expr}`);
  return key;
}

let configPromise = null;
function getConfig() {
  configPromise ??= fetch('/config.json', { cache: 'no-store' }).then((r) => r.json());
  return configPromise;
}

let snapshotPromise = null;
let snapshotAt = 0;
function getSnapshot(path) {
  const now = Date.now();
  if (!snapshotPromise || now - snapshotAt >= SNAPSHOT_TTL_MS) {
    snapshotAt = now;
    snapshotPromise = fetch(path, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`snapshot ${r.status}`);
      return r.json();
    });
  }
  return snapshotPromise;
}

async function get(path, params) {
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams(params)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`${path} ${body.error || 'failed'}`);
  return body.data.result;
}

// entry.result is [{metric, value|values}], the same shape Prometheus's own API returns —
// the publisher (homelab-wall-feed) writes it straight from its own query responses.
function fromSnapshot(entry, key) {
  if (!entry) throw new Error(`snapshot missing ${key}`);
  return entry.result;
}

// Instant vector -> [{labels, value}]
export async function query(expr) {
  const cfg = await getConfig();
  if (cfg.snapshot) {
    const key = keyFor(expr);
    const snap = await getSnapshot(cfg.snapshot);
    const rows = fromSnapshot(snap.instant?.[key], key);
    return rows.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
  }
  const rows = await get('query', { query: expr });
  return rows.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}

// Range vector -> [{labels, values:[number]}]
export async function range(expr, minutes, stepSeconds) {
  const cfg = await getConfig();
  if (cfg.snapshot) {
    const key = keyFor(expr);
    const snap = await getSnapshot(cfg.snapshot);
    const rows = fromSnapshot(snap.range?.[key], key);
    return rows.map((r) => ({ labels: r.metric, values: r.values.map((v) => Number(v[1])) }));
  }
  const end = Math.floor(Date.now() / 1000);
  const rows = await get('query_range', { query: expr, start: end - minutes * 60, end, step: stepSeconds });
  return rows.map((r) => ({ labels: r.metric, values: r.values.map((v) => Number(v[1])) }));
}

// Run every query; a failed one yields null so only its panel shows "pending".
export async function settle(named) {
  const keys = Object.keys(named);
  const out = await Promise.allSettled(keys.map((k) => named[k]()));
  return Object.fromEntries(keys.map((k, i) => [k, out[i].status === 'fulfilled' ? out[i].value : null]));
}

// "pve-w1700.example.com:9100" -> "pve-w1700"
export const shortHost = (instance = '') => instance.split(':')[0].split('.')[0];
