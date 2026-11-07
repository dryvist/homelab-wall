import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Q } from '../site/lib/queries.js';
import { BENCHMARK_Q, BENCHMARK_SOURCE_AGE_FOR, BENCHMARK_SOURCE_AGE_Q } from '../site/lib/benchmarkQueries.js';
import fixtures from './mc7-fixtures.json' with { type: 'json' };

test('generated allow-list equals Q; every MC7 query has a fixture and a unique expression', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../site/queries.json', import.meta.url))), Q);
  assert.deepEqual(Object.keys(fixtures).sort(), [...Object.keys(BENCHMARK_Q), 'llmTokRate'].sort());
  assert.equal(new Set(Object.values(Q)).size, Object.keys(Q).length);
});

test('every benchmark reading has an allow-listed raw-source age query', () => {
  assert.deepEqual(Object.keys(BENCHMARK_SOURCE_AGE_FOR).sort(), [...Object.keys(BENCHMARK_Q), 'llmTokRate'].sort());
  assert.deepEqual(new Set(Object.values(BENCHMARK_SOURCE_AGE_FOR)), new Set(Object.keys(BENCHMARK_SOURCE_AGE_Q)));
  for (const [reading, ageKey] of Object.entries(BENCHMARK_SOURCE_AGE_FOR)) {
    assert.equal(Q[ageKey], BENCHMARK_SOURCE_AGE_Q[ageKey]);
    assert.match(Q[ageKey], /max by \([^)]*\).*tlast_over_time\(/);
    assert.ok(reading);
  }
});

test('engine and router percentiles use standard buckets, aggregate le, and drop accelerator', () => {
  for (const [key, expr] of Object.entries(BENCHMARK_Q)) {
    assert.equal(Q[key], expr);
    assert.doesNotMatch(expr, /api_key|team|api_base|position|\bvector\(/);
    if (!/P\d+$/.test(key)) continue;
    assert.match(expr, /histogram_quantile\(/);
    assert.match(expr, /sum by \((?:model_name|model), le\)/);
    assert.match(expr, /increase\([^()]*_bucket\{job="llm_(gpu_engine|router)"\}\[5m\]\)/);
    assert.doesNotMatch(expr, /by \([^)]*accelerator/);
    const p = Number(key.match(/P(\d+)$/)[1]) / 100;
    assert.ok(expr.includes(`histogram_quantile(${p},`));
  }
  assert.match(Q.engineE2eP95, /vllm:e2e_request_latency_seconds_bucket/);
  assert.match(Q.routerTtftP95, /litellm_llm_api_time_to_first_token_metric_bucket/);
  assert.match(Q.routerE2eP95, /litellm_request_total_latency_metric_bucket/);
});

test('rates, cache ratios, and measured efficiency have the expected windows and labels', () => {
  assert.match(Q.engineDecode, /rate\(vllm:generation_tokens_total\{job="llm_gpu_engine"\}\[5m\]\)/);
  assert.match(Q.engineDecode, /llamacpp:tokens_predicted_total/);
  assert.match(Q.enginePrefill, /llamacpp:prompt_tokens_total/);
  for (const key of ['enginePrefixPercent', 'engineSpecPercent']) assert.match(Q[key], /> 0/);
  assert.match(Q.engineDevices, /group by \(backend, model, accelerator\)/);
  assert.match(Q.engineDevices, /accelerator!=""/);
  assert.match(Q.acceleratorTokensPerJoule, /accelerator:generation_tokens_per_second:rate1h/);
  assert.match(Q.acceleratorTokensPerJoule, /avg_over_time\(DCGM_FI_DEV_POWER_USAGE\[1h\]\)/);
  assert.match(Q.acceleratorTokensPerJoule, /avg_over_time\(macmon_gpu_power_watts\[1h\]\)/);
  assert.match(Q.acceleratorTokensPerJoule, /on \(accelerator\)/);
  assert.match(Q.acceleratorTokensPerJoule, /> 0/);
  assert.doesNotMatch(Q.acceleratorTokensPerJoule, /max_generation|token_utilization/);
});

test('compound source ages require every raw input and efficiency uses raw token counters', () => {
  const prefix = Q.enginePrefixSourceAge;
  assert.match(prefix, /vllm:prefix_cache_hits_total\{job="llm_gpu_engine"\}.* <= .*vllm:prefix_cache_queries_total\{job="llm_gpu_engine"\}/);
  assert.match(prefix, /vllm:prefix_cache_queries_total\{job="llm_gpu_engine"\}.* < .*vllm:prefix_cache_hits_total\{job="llm_gpu_engine"\}/);

  const spec = Q.engineSpecSourceAge;
  assert.match(spec, /vllm:spec_decode_num_accepted_tokens_total.* <= .*vllm:spec_decode_num_draft_tokens_total/);
  assert.match(spec, /llamacpp:spec_decode_num_accepted_tokens_total.* <= .*llamacpp:spec_decode_num_draft_tokens_total/);
  assert.equal((spec.match(/ < /g) || []).length, 2);

  const jouleAge = Q.acceleratorTokensPerJouleSourceAge;
  for (const selector of [
    'vllm:generation_tokens_total{job="llm_gpu_engine"}',
    'llamacpp:tokens_predicted_total{job="llm_gpu_engine"}',
    'litellm_output_tokens_metric_total{job="llm_router",model="mlx-community/Qwen3.8-27B-4bit",team!="litellm-internal-health-check"}',
  ]) assert.ok(jouleAge.includes(selector));
  assert.match(jouleAge, /"accelerator", "gpu-primary", "accelerator", "\^\$"/);
  assert.match(jouleAge, /"accelerator", "gpu-secondary", "accelerator", "\^\$"/);
  assert.match(jouleAge, /"accelerator", "mac-primary", "accelerator", "\^\$"/);
  assert.match(jouleAge, /DCGM_FI_DEV_POWER_USAGE/);
  assert.match(jouleAge, /macmon_gpu_power_watts/);
  assert.doesNotMatch(jouleAge, /accelerator:generation_tokens_per_second:rate1h/);
  // Pairwise minimum of token-source and power ages: each side keeps the other's older value.
  assert.match(jouleAge, /^\(\(.*\) <= \(.*\)\) or \(\(.*\) < \(.*\)\)$/);
  assert.equal(jouleAge.split(' <= ').length - 1, 1);
  assert.equal(jouleAge.split(' < ').length - 1, 1);
});

test('llama.cpp branches preserve guest identity without requiring model metadata', () => {
  for (const expr of Object.values(BENCHMARK_Q)) {
    const llama = expr.split(' or ').filter((branch) => branch.includes('llamacpp:'));
    for (const branch of llama) {
      assert.doesNotMatch(branch, /model_name|\bmodel\b/);
      assert.match(branch, /by \([^)]*guest/);
      assert.match(branch, /"backend", "llamacpp"/);
    }
  }
  assert.match(Q.engineDevices.split(' or ')[1], /by \(backend, guest, accelerator\)/);
});

test('MC7 never imports sample values', () => {
  for (const file of ['mc7', 'render', 'data', 'history']) {
    const source = readFileSync(new URL(`../site/mc7/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sampleData|SAMPLE_|Math\.random|fill\(tok\)/);
  }
});
