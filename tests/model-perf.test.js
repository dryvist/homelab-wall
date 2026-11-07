import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Q } from '../site/lib/queries.js';
import { listedModels, perfReader, perfCard } from '../site/lib/modelPerf.js';

// MC1 and MC3 model lists: router requests from real callers, never the router's own health check.
const H = 'api_key_alias!="litellm-internal-health-check"';

test('per-request model queries read real callers from bucket series only and stay unique', () => {
  assert.equal(Q.llmUsed4d, `sum by (model) (increase(litellm_request_total_latency_metric_bucket{le="+Inf",${H}}[4d])) > 0`);
  assert.equal(Q.llmRequests1h, `sum by (model) (increase(litellm_request_total_latency_metric_bucket{le="+Inf",${H}}[1h]))`);
  for (const [key, q] of [['llmRequestP50', 0.5], ['llmRequestP90', 0.9], ['llmRequestP99', 0.99]]) {
    assert.equal(Q[key], `histogram_quantile(${q}, sum by (model, le) (increase(litellm_request_total_latency_metric_bucket{${H}}[1h])))`);
  }
  assert.equal(Q.llmTtftP50, `histogram_quantile(0.5, sum by (model, le) (increase(litellm_llm_api_time_to_first_token_metric_bucket{${H}}[1h])))`);
  for (const [key, q] of [['llmDecodeP50', 0.5], ['llmDecodeP90', 0.9], ['llmDecodeP99', 0.99]]) {
    assert.equal(Q[key], `1 / histogram_quantile(${q}, sum by (model_name, le) (increase(vllm:request_time_per_output_token_seconds_bucket[1h])))`);
  }
  assert.equal(Q.llmLastRequest, `tlast_change_over_time(sum by (model) (litellm_request_total_latency_metric_bucket{le="+Inf",${H}})[4d:1m])`);
  // MC7 still reads the 5m output rate.
  assert.equal(Q.llmTokRate, 'sum by (model) (rate(litellm_output_tokens_metric_total[5m]))');
  assert.equal(new Set(Object.values(Q)).size, Object.keys(Q).length);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../site/queries.json', import.meta.url))), Q);
});

const row = (value, labels) => ({ value, labels });
const state = (...names) => names.map((n) => row(0, { litellm_model_name: n }));
const NOW = 1_800_000_000;
// One poll as MC3 settles it: model-a decodes on the engine, model-b reads request time only, and
// model-c's engine still answers the router's health check after its last real request.
const POLL = {
  requests: [row(42, { model: 'model-a' }), row(0.4, { model: 'model-b' }), row(0, { model: 'model-c' })],
  requestP50: [row(1.84, { model: 'model-a' }), row(0.62, { model: 'model-b' })],
  requestP90: [row(3.2, { model: 'model-a' }), row(1.4, { model: 'model-b' })],
  requestP99: [row(5.6, { model: 'model-a' }), row(96.4, { model: 'model-b' })],
  ttftP50: [row(0.31, { model: 'model-a' })],
  decodeP50: [row(104.2, { model_name: 'model-a' }), row(98, { model_name: 'model-c' })],
  decodeP90: [row(88.4, { model_name: 'model-a' }), row(80, { model_name: 'model-c' })],
  decodeP99: [row(61, { model_name: 'model-a' }), row(Infinity, { model_name: 'model-c' })],
  lastRequest: [row(NOW - 30, { model: 'model-a' }), row(NOW - (3 * 3600 + 12 * 60), { model: 'model-c' })],
};

test('the list keeps models with a real request in 4d, busiest first, and drops health-check-only ones', () => {
  const used = [row(1, { model: 'model-b' }), row(9, { model: 'model-a' }), row(3, { model: 'model-c' })];
  const listed = listedModels(state('model-c', 'health-only', 'model-a', 'model-b'), used, POLL.requests);
  assert.deepEqual(listed.map((r) => r.labels.litellm_model_name), ['model-a', 'model-b', 'model-c']);
  // A failed request count leaves the order to the name.
  assert.deepEqual(listedModels(state('model-c', 'model-a'), used, null).map((r) => r.labels.litellm_model_name), ['model-a', 'model-c']);
});

test('a failed used-models query lists every deployment rather than an empty wall', () => {
  const listed = listedModels(state('health-only', 'model-b', 'model-a'), null, POLL.requests);
  assert.deepEqual(listed.map((r) => r.labels.litellm_model_name), ['model-a', 'model-b', 'health-only']);
  // A query that answered with no row is real absence: nothing is listed.
  assert.deepEqual(listedModels(state('model-a'), [], POLL.requests), []);
});

test('no real request in the hour reads Idle with the last request age, never a token rate', () => {
  const perf = perfReader(POLL);
  // model-c's engine rows come from health-check traffic; the router count of real requests is zero.
  assert.deepEqual(perfCard(perf('model-c'), NOW), { value: 'Idle', unit: '', stats: ['last request 3h 12m ago'], spark: null });
  // No row at all, and no last-request time either.
  assert.deepEqual(perfCard(perf('model-z'), NOW), { value: 'Idle', unit: '', stats: ['no request in the last hour'], spark: null });
  const dayOld = perfReader({ ...POLL, lastRequest: [row(NOW - 90_000, { model: 'model-c' })] });
  assert.equal(perfCard(dayOld('model-c'), NOW).stats[0], 'last request 1d 1h ago');
});

test('decode speed is the large number when the engine reports it, with its slow tail labelled', () => {
  assert.deepEqual(perfCard(perfReader(POLL)('model-a'), NOW), {
    value: '104',
    unit: 'tok/s',
    stats: [
      'p50 1.8 s · p90 3.2 s · p99 5.6 s per request · 42 req/h',
      'decode p90 88 · p99 61 tok/s (slowest 10% / 1%)',
      'TTFT p50 0.31 s',
    ],
    spark: 104.2,
  });
});

test('request time is the large number without an engine row', () => {
  assert.deepEqual(perfCard(perfReader(POLL)('model-b'), NOW), {
    value: '0.62',
    unit: 's per request',
    // A fractional increase() over a real request still counts one.
    stats: ['p50 0.62 s · p90 1.4 s · p99 96 s per request · 1 req/h'],
    spark: 0.62,
  });
});

test('failed percentile or count queries show what was measured and never invent Idle', () => {
  // The percentile queries failed (settle() gives null): the request count is the only reading.
  const noPercentiles = { requests: POLL.requests, requestP50: null, requestP90: null, requestP99: null, decodeP50: null };
  assert.deepEqual(perfCard(perfReader(noPercentiles)('model-a'), NOW), { value: '42', unit: 'req/h', stats: ['42 req/h'], spark: 42 });
  // The count failed: a model with a percentile row is serving, one without is idle.
  const noCount = perfReader({ ...POLL, requests: null });
  assert.equal(perfCard(noCount('model-b'), NOW).value, '0.62');
  assert.equal(perfCard(noCount('model-b'), NOW).stats[0], 'p50 0.62 s · p90 1.4 s · p99 96 s per request');
  assert.equal(perfCard(noCount('model-z'), NOW).value, 'Idle');
});
