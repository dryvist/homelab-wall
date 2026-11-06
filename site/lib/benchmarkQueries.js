// Engine counters stay separate from router accounting. Export only backend/model labels.
const engine = (expr, backend) => `sum by (backend, model) (label_replace(label_replace(${expr}, "model", "$1", "model_name", "(.*)"), "backend", "${backend}", "", ""))`;
const v = (expr) => engine(expr, 'vllm');
const l = (expr) => engine(expr, 'llamacpp');
const rate = (name) => `sum by (model_name) (rate(${name}{job="llm_gpu_engine"}[5m]))`;
const gauge = (name, agg = 'sum') => `${agg} by (model_name) (${name}{job="llm_gpu_engine"})`;
const quantile = (name, p) => v(`histogram_quantile(${p}, sum by (model_name, le) (rate(vllm:${name}_seconds{job="llm_gpu_engine",le!=""}[5m])))`);
// Router summary sums/counts receive phantom zeros; keep timings unavailable until repaired.
export const ROUTER_AVERAGES_UNAVAILABLE = 'NO DATA · router averages pending ingest fix';
// Power is a device total. The 1h denominator matches the recording rule's token window.
const power = (window) => `sum by (accelerator) (label_replace(avg_over_time(DCGM_FI_DEV_POWER_USAGE[${window}]), "accelerator", "gpu-primary", "accelerator", "^$")) or sum by (accelerator) (avg_over_time(macmon_gpu_power_watts[${window}]))`;

export const BENCHMARK_Q = {
  engineDecode: `${v(rate('vllm:generation_tokens_total'))} or ${l(rate('llamacpp:tokens_predicted_total'))}`,
  enginePrefill: `${v(rate('vllm:prompt_tokens_total'))} or ${l(rate('llamacpp:prompt_tokens_total'))}`,
  engineTtftP50: quantile('time_to_first_token', 0.5),
  engineTtftP95: quantile('time_to_first_token', 0.95),
  engineTtftP99: quantile('time_to_first_token', 0.99),
  engineItlP50: quantile('inter_token_latency', 0.5),
  engineItlP99: quantile('inter_token_latency', 0.99),
  engineRunning: `${v(gauge('vllm:num_requests_running'))} or ${l(gauge('llamacpp:requests_processing'))}`,
  engineWaiting: `${v(gauge('vllm:num_requests_waiting'))} or ${l(gauge('llamacpp:requests_deferred'))}`,
  engineKvPercent: v(`100 * ${gauge('vllm:kv_cache_usage_perc', 'avg')}`),
  enginePrefixPercent: v(`100 * ${rate('vllm:prefix_cache_hits_total')} / (${rate('vllm:prefix_cache_queries_total')} > 0)`),
  engineSpecPercent: `${v(`100 * ${rate('vllm:spec_decode_num_accepted_tokens_total')} / (${rate('vllm:spec_decode_num_draft_tokens_total')} > 0)`)} or ${l(`100 * ${rate('llamacpp:spec_decode_num_accepted_tokens_total')} / (${rate('llamacpp:spec_decode_num_draft_tokens_total')} > 0)`)}`,
  routerInput: 'sum by (model) (rate(litellm_input_tokens_metric_total[5m]))',
  acceleratorWatts: power('5m'),
  acceleratorTokensPerJoule: `accelerator:generation_tokens_per_second:rate1h / on (accelerator) ((${power('1h')}) > 0)`,
};
