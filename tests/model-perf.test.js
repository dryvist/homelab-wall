import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Q } from '../site/lib/queries.js';

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
