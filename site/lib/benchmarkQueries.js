// Engine counters stay separate from router accounting. llama.cpp exposes guest, not model metadata.
const engine = (expr, backend) => `sum by (backend, model) (label_replace(label_replace(${expr}, "model", "$1", "model_name", "(.*)"), "backend", "${backend}", "", ""))`;
const v = (expr) => engine(expr, 'vllm');
const l = (expr) => `sum by (backend, guest) (label_replace(${expr}, "backend", "llamacpp", "", ""))`;
const identity = (name) => name.startsWith('llamacpp:') ? 'guest' : 'model_name';
const rate = (name) => `sum by (${identity(name)}) (rate(${name}{job="llm_gpu_engine"}[5m]))`;
const gauge = (name, agg = 'sum') => `${agg} by (${identity(name)}) (${name}{job="llm_gpu_engine"})`;
// Percentiles use increase(), which also counts a new series' first small bucket value; rate() skips it.
const quantile = (name, p) => v(`histogram_quantile(${p}, sum by (model_name, le) (increase(vllm:${name}_seconds_bucket{job="llm_gpu_engine"}[5m])))`);
const routerQuantile = (name, p) => `histogram_quantile(${p}, sum by (model, le) (increase(litellm_${name}_bucket{job="llm_router"}[5m])))`;
const devices = (name, backend) => {
  const source = `${name}{job="llm_gpu_engine",accelerator!=""}`;
  const labels = backend === 'llamacpp' ? source : `label_replace(${source}, "model", "$1", "model_name", "(.*)")`;
  return `group by (backend, ${backend === 'llamacpp' ? 'guest' : 'model'}, accelerator) (label_replace(${labels}, "backend", "${backend}", "", ""))`;
};
// Power is a device total. The 1h denominator matches the hourly token rate rule's window.
const power = (window) => `sum by (accelerator) (label_replace(avg_over_time(DCGM_FI_DEV_POWER_USAGE[${window}]), "accelerator", "gpu-primary", "accelerator", "^$")) or sum by (accelerator) (avg_over_time(macmon_gpu_power_watts[${window}]))`;

const gpuAge = (metric) => `max by (backend, model) (label_replace(label_replace(tlast_over_time(${metric}{job="llm_gpu_engine"}[5m]), "model", "$1", "model_name", "(.*)"), "backend", "vllm", "", ""))`;
const llamaAge = (metric) => `max by (backend, guest) (label_replace(tlast_over_time(${metric}{job="llm_gpu_engine"}[5m]), "backend", "llamacpp", "", ""))`;
const gpuDeviceAge = (metric) => `max by (backend, model, accelerator) (label_replace(label_replace(tlast_over_time(${metric}{job="llm_gpu_engine",accelerator!=""}[5m]), "model", "$1", "model_name", "(.*)"), "backend", "vllm", "", ""))`;
const llamaDeviceAge = (metric) => `max by (backend, guest, accelerator) (label_replace(tlast_over_time(${metric}{job="llm_gpu_engine",accelerator!=""}[5m]), "backend", "llamacpp", "", ""))`;
const powerAge = 'max by (accelerator) (label_replace(tlast_over_time(DCGM_FI_DEV_POWER_USAGE[5m]), "accelerator", "gpu-primary", "accelerator", "^$")) or max by (accelerator) (tlast_over_time(macmon_gpu_power_watts[5m]))';
const older = (a, b) => `(${a} <= ${b}) or (${b} < ${a})`;
const tokenSourceAge = [
  'max by (accelerator) (label_replace(tlast_over_time(vllm:generation_tokens_total{job="llm_gpu_engine"}[5m]), "accelerator", "gpu-primary", "accelerator", "^$"))',
  'max by (accelerator) (label_replace(tlast_over_time(llamacpp:tokens_predicted_total{job="llm_gpu_engine"}[5m]), "accelerator", "gpu-secondary", "accelerator", "^$"))',
  'max by (accelerator) (label_replace(tlast_over_time(litellm_output_tokens_metric_total{job="llm_router",model="mlx-community/Qwen3.8-27B-4bit",team!="litellm-internal-health-check"}[5m]), "accelerator", "mac-primary", "accelerator", "^$"))',
].join(' or ');

// One source-age query per raw-series group. Percentiles sharing a histogram reuse its age query.
export const BENCHMARK_SOURCE_AGE_FOR = {
  engineDecode: 'engineDecodeSourceAge', enginePrefill: 'enginePrefillSourceAge',
  engineTtftP50: 'engineTtftSourceAge', engineTtftP95: 'engineTtftSourceAge', engineTtftP99: 'engineTtftSourceAge',
  engineItlP50: 'engineItlSourceAge', engineItlP99: 'engineItlSourceAge', engineE2eP95: 'engineE2eSourceAge',
  engineDevices: 'engineDevicesSourceAge', engineRunning: 'engineRunningSourceAge', engineWaiting: 'engineWaitingSourceAge',
  engineKvPercent: 'engineKvSourceAge', enginePrefixPercent: 'enginePrefixSourceAge', engineSpecPercent: 'engineSpecSourceAge',
  routerInput: 'routerInputSourceAge', routerTtftP50: 'routerTtftSourceAge', routerTtftP95: 'routerTtftSourceAge',
  routerE2eP95: 'routerE2eSourceAge', acceleratorWatts: 'acceleratorWattsSourceAge',
  acceleratorTokensPerJoule: 'acceleratorTokensPerJouleSourceAge', llmTokRate: 'llmTokRateSourceAge',
};

export const BENCHMARK_SOURCE_AGE_Q = {
  engineDecodeSourceAge: `${gpuAge('vllm:generation_tokens_total')} or ${llamaAge('llamacpp:tokens_predicted_total')}`,
  enginePrefillSourceAge: `${gpuAge('vllm:prompt_tokens_total')} or ${llamaAge('llamacpp:prompt_tokens_total')}`,
  engineTtftSourceAge: gpuAge('vllm:time_to_first_token_seconds_bucket'),
  engineItlSourceAge: gpuAge('vllm:inter_token_latency_seconds_bucket'),
  engineE2eSourceAge: gpuAge('vllm:e2e_request_latency_seconds_bucket'),
  engineDevicesSourceAge: `${gpuDeviceAge('vllm:time_to_first_token_seconds_count')} or ${llamaDeviceAge('llamacpp:requests_processing')}`,
  engineRunningSourceAge: `${gpuAge('vllm:num_requests_running')} or ${llamaAge('llamacpp:requests_processing')}`,
  engineWaitingSourceAge: `${gpuAge('vllm:num_requests_waiting')} or ${llamaAge('llamacpp:requests_deferred')}`,
  engineKvSourceAge: gpuAge('vllm:kv_cache_usage_perc'),
  enginePrefixSourceAge: older(gpuAge('vllm:prefix_cache_hits_total'), gpuAge('vllm:prefix_cache_queries_total')),
  engineSpecSourceAge: `(${older(gpuAge('vllm:spec_decode_num_accepted_tokens_total'), gpuAge('vllm:spec_decode_num_draft_tokens_total'))}) or (${older(llamaAge('llamacpp:spec_decode_num_accepted_tokens_total'), llamaAge('llamacpp:spec_decode_num_draft_tokens_total'))})`,
  routerInputSourceAge: 'max by (model) (tlast_over_time(litellm_input_tokens_metric_total[5m]))',
  routerTtftSourceAge: 'max by (model) (tlast_over_time(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router"}[5m]))',
  routerE2eSourceAge: 'max by (model) (tlast_over_time(litellm_request_total_latency_metric_bucket{job="llm_router"}[5m]))',
  acceleratorWattsSourceAge: powerAge,
  acceleratorTokensPerJouleSourceAge: older(`(${tokenSourceAge})`, `(${powerAge})`),
  llmTokRateSourceAge: 'max by (model) (tlast_over_time(litellm_output_tokens_metric_total[5m]))',
};

export const BENCHMARK_Q = {
  engineDecode: `${v(rate('vllm:generation_tokens_total'))} or ${l(rate('llamacpp:tokens_predicted_total'))}`,
  enginePrefill: `${v(rate('vllm:prompt_tokens_total'))} or ${l(rate('llamacpp:prompt_tokens_total'))}`,
  engineTtftP50: quantile('time_to_first_token', 0.5),
  engineTtftP95: quantile('time_to_first_token', 0.95),
  engineTtftP99: quantile('time_to_first_token', 0.99),
  engineItlP50: quantile('inter_token_latency', 0.5),
  engineItlP99: quantile('inter_token_latency', 0.99),
  engineE2eP95: quantile('e2e_request_latency', 0.95),
  engineDevices: `${devices('vllm:time_to_first_token_seconds_count', 'vllm')} or ${devices('llamacpp:requests_processing', 'llamacpp')}`,
  engineRunning: `${v(gauge('vllm:num_requests_running'))} or ${l(gauge('llamacpp:requests_processing'))}`,
  engineWaiting: `${v(gauge('vllm:num_requests_waiting'))} or ${l(gauge('llamacpp:requests_deferred'))}`,
  engineKvPercent: v(`100 * ${gauge('vllm:kv_cache_usage_perc', 'avg')}`),
  enginePrefixPercent: v(`100 * ${rate('vllm:prefix_cache_hits_total')} / (${rate('vllm:prefix_cache_queries_total')} > 0)`),
  engineSpecPercent: `${v(`100 * ${rate('vllm:spec_decode_num_accepted_tokens_total')} / (${rate('vllm:spec_decode_num_draft_tokens_total')} > 0)`)} or ${l(`100 * ${rate('llamacpp:spec_decode_num_accepted_tokens_total')} / (${rate('llamacpp:spec_decode_num_draft_tokens_total')} > 0)`)}`,
  routerInput: 'sum by (model) (rate(litellm_input_tokens_metric_total[5m]))',
  routerTtftP50: routerQuantile('llm_api_time_to_first_token_metric', 0.5),
  routerTtftP95: routerQuantile('llm_api_time_to_first_token_metric', 0.95),
  routerE2eP95: routerQuantile('request_total_latency_metric', 0.95),
  acceleratorWatts: power('5m'),
  acceleratorTokensPerJoule: `accelerator:generation_tokens_per_second:rate1h / on (accelerator) ((${power('1h')}) > 0)`,
};
