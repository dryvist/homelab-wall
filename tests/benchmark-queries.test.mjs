import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Q } from '../site/lib/queries.js';
import { BENCHMARK_Q } from '../site/lib/benchmarkQueries.js';
import { SAMPLE_BENCHMARKS } from '../site/lib/sampleData.js';

test('generated allow-list equals Q and every benchmark expression has a test fixture', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../site/queries.json', import.meta.url))), Q);
  assert.deepEqual(Object.keys(SAMPLE_BENCHMARKS).sort(), Object.keys(BENCHMARK_Q).sort());
  assert.equal(new Set(Object.values(Q)).size, Object.keys(Q).length);
});

test('percentiles use clean base histograms and no query uses corrupted sums or counts', () => {
  for (const expr of Object.values(Q)) assert.doesNotMatch(expr, /_sum\b|_count\b/);
  for (const key of ['routerTtftAvg', 'routerItlAvg', 'llmQueueSeconds', 'llmLatencySeconds']) {
    assert.equal(Q[key], undefined);
  }
  assert.match(Q.routerInput, /rate\(litellm_input_tokens_metric_total\[5m\]\)/);
  assert.match(Q.llmTokRate, /rate\(litellm_output_tokens_metric_total\[5m\]\)/);
  for (const [key, expr] of Object.entries(BENCHMARK_Q)) {
    assert.equal(Q[key], expr);
    assert.doesNotMatch(expr, /api_key|team|api_base|position|\bvector\(/);
    if (/P\d+$/.test(key)) {
      assert.match(expr, /histogram_quantile\(/);
      assert.match(expr, /sum by \(model_name, le\)/);
      assert.match(expr, /vllm:(time_to_first_token|inter_token_latency)_seconds\{/);
      assert.doesNotMatch(expr, /_bucket|litellm/);
    }
  }
});

test('efficiency uses recorded tokens and measured power over the same hour', () => {
  assert.match(Q.acceleratorTokensPerJoule, /accelerator:generation_tokens_per_second:rate1h/);
  assert.match(Q.acceleratorTokensPerJoule, /avg_over_time\(DCGM_FI_DEV_POWER_USAGE\[1h\]\)/);
  assert.match(Q.acceleratorTokensPerJoule, /avg_over_time\(macmon_gpu_power_watts\[1h\]\)/);
  assert.match(Q.acceleratorTokensPerJoule, /on \(accelerator\)/);
  assert.match(Q.acceleratorTokensPerJoule, /> 0/);
  assert.doesNotMatch(Q.acceleratorTokensPerJoule, /max_generation|token_utilization/);
});

test('benchmark fixtures carry only bounded dimensions and MC3 never imports sample data', () => {
  for (const rows of Object.values(SAMPLE_BENCHMARKS)) {
    for (const row of rows) {
      assert.ok(Number.isFinite(row.value));
      assert.ok(Object.keys(row.labels).every((label) => ['backend', 'model', 'accelerator'].includes(label)));
    }
  }
  for (const file of ['mc3', 'benchmarks', 'fleet', 'accelerators', 'reactor2d', 'recent']) {
    const source = readFileSync(new URL(`../site/mc3/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sampleData|SAMPLE_LLM|pushHist|fill\(tok\)/);
    assert.doesNotMatch(source, /_sum\b|_count\b|Q\.(llmQueueSeconds|llmLatencySeconds|routerTtftAvg|routerItlAvg)/);
  }
});
