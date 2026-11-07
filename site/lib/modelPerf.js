// The MC1 and MC3 model lists: which models served real requests, and what each request measured
// (Q.llmUsed4d to Q.llmLastRequest, site/lib/queries.js). No DOM and no fetch, so node:test reads it.

const byLabel = (rows, label) => new Map((rows ?? []).filter((r) => Number.isFinite(r.value)).map((r) => [r.labels[label], r.value]));
const nameOf = (row) => row.labels.litellm_model_name;

// Q.llmState rows for the models with a Q.llmUsed4d row, busiest first (Q.llmRequests1h), then by
// name. A failed Q.llmUsed4d (null) lists every deployment, as before, so one failed query never
// empties the list; the page marks that failure.
export function listedModels(state, used, requests) {
  const busy = byLabel(requests, 'model');
  const real = used == null ? null : new Set(used.map((r) => r.labels.model));
  return state.filter((r) => !real || real.has(nameOf(r)))
    .sort((a, b) => (busy.get(nameOf(b)) ?? 0) - (busy.get(nameOf(a)) ?? 0) || nameOf(a).localeCompare(nameOf(b)));
}

// Reads one settle() result, keyed requests, requestP50/P90/P99, ttftP50, decodeP50/P90/P99 and
// lastRequest, into a per-model lookup. A percentile with no row means no request in its hour.
export function perfReader(r) {
  const router = (key) => byLabel(r[key], 'model');
  const engine = (key) => byLabel(r[key], 'model_name');
  const requests = r.requests == null ? null : router('requests');
  const request = { p50: router('requestP50'), p90: router('requestP90'), p99: router('requestP99') };
  const decode = { p50: engine('decodeP50'), p90: engine('decodeP90'), p99: engine('decodeP99') };
  const ttft = router('ttftP50'), last = router('lastRequest');
  return (n) => {
    const p = {
      requests: requests?.get(n),
      request: { p50: request.p50.get(n), p90: request.p90.get(n), p99: request.p99.get(n) },
      decode: { p50: decode.p50.get(n), p90: decode.p90.get(n), p99: decode.p99.get(n) },
      ttft: ttft.get(n),
      last: last.get(n),
    };
    // No real request in the hour is idle, whatever the engine saw (the health check reaches it too).
    // Without the count (its query failed), a model with no percentile row is idle.
    p.idle = requests ? !(p.requests > 0) : !Number.isFinite(p.request.p50) && !Number.isFinite(p.decode.p50);
    return p;
  };
}

const fmtTok = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
const fmtSec = (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v)));
// A model with any request in the hour had at least one, whatever increase() extrapolated.
const fmtCount = (n) => (n > 0 ? String(Math.max(1, Math.round(n))) : '0');
function fmtAge(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// A model card's text: the large number and its unit, the secondary lines, and the sparkline
// reading (null while idle, so the sparkline leaves a gap rather than drawing a zero).
export function perfCard(p, now = Date.now() / 1000) {
  if (p.idle) {
    const since = Number.isFinite(p.last) ? `last request ${fmtAge(now - p.last)} ago` : 'no request in the last hour';
    return { value: 'Idle', unit: '', stats: [since], spark: null };
  }
  const fin = Number.isFinite;
  const stats = [];
  const times = [['p50', p.request?.p50], ['p90', p.request?.p90], ['p99', p.request?.p99]].filter(([, v]) => fin(v));
  const load = [
    times.length ? `${times.map(([k, v]) => `${k} ${fmtSec(v)} s`).join(' · ')} per request` : '',
    fin(p.requests) ? `${fmtCount(p.requests)} req/h` : '',
  ].filter(Boolean);
  if (load.length) stats.push(load.join(' · '));
  // The slow tail of decode speed: "p90 88" means 90% of requests decoded at 88 tok/s or faster.
  const tail = [['p90', '10%', p.decode?.p90], ['p99', '1%', p.decode?.p99]].filter(([, , v]) => fin(v));
  if (tail.length) {
    stats.push(`decode ${tail.map(([k, , v]) => `${k} ${fmtTok(v)}`).join(' · ')} tok/s (slowest ${tail.map(([, share]) => share).join(' / ')})`);
  }
  if (fin(p.ttft)) stats.push(`TTFT p50 ${fmtSec(p.ttft)} s`);
  if (fin(p.decode?.p50)) return { value: fmtTok(p.decode.p50), unit: 'tok/s', stats, spark: p.decode.p50 };
  if (fin(p.request?.p50)) return { value: fmtSec(p.request.p50), unit: 's per request', stats, spark: p.request.p50 };
  // Requests counted but no percentile row yet (its query failed): the count is the only reading.
  return { value: fmtCount(p.requests ?? 0), unit: 'req/h', stats, spark: fin(p.requests) ? p.requests : null };
}
