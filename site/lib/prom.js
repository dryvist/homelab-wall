// Read-only Prometheus client. The gateway (homelab-wall-feed) exposes only
// GET /api/prom/query and /api/prom/query_range on the wall's own origin.
const BASE = '/api/prom';

async function get(path, params) {
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams(params)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`${path} ${body.error || 'failed'}`);
  return body.data.result;
}

// Instant vector -> [{labels, value}]
export async function query(expr) {
  const rows = await get('query', { query: expr });
  return rows.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}

// Range vector -> [{labels, values:[number]}]
export async function range(expr, minutes, stepSeconds) {
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
