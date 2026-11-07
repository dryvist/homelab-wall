import { MC9_QUERIES } from '../mc9/queries.js';

// PromQL used by the wall. APP_HEALTH_SCORE is the single base definition of
// the 0-9(-10) app health score; prometheus-homelab-rules records the identical
// expression as homelab:app_health_score, which Q.appScore prefers once it exists.
//
// KNOWN GAP: that precomputed metric is defined in a separate repo and still encodes the old
// 0-100 formula. Q.appScore's "or" prefers it when present, so the live wall keeps showing 0-100
// values until that definition is updated to match this expression — this file alone cannot fix it.
import { BENCHMARK_Q, BENCHMARK_SOURCE_AGE_Q } from './benchmarkQueries.js';

const CATALOG = 'group=~".+ · (UI|API)"';
const NODE = 'job="pve_node_exporter"';
// A network mount of another node's own pool reports the same bytes as that pool's own local
// reading under a different device+mountpoint, so it must be excluded here rather than deduped
// after the fact — the storage panel would otherwise count that capacity twice (D3 covers the
// true-shared-device case: one mountpoint, several hosts).
const FS = `${NODE},fstype!~"tmpfs|devtmpfs|overlay|squashfs|ramfs|fuse.*|nsfs|efivarfs|vfat|nfs.?|cifs|smb3|ceph.*|glusterfs"`;

// 0-9 is the normal scale (min(9, round(9 x 24h success ratio))); 10 is reserved for an app that
// had 100% success over the trailing 30d — a second, longer-window ratio decides that bonus tier,
// combined into this one expression so every consumer still makes a single query.
const RATIO_24H = `(sum by (name) (increase(gatus_results_total{${CATALOG},success="true"}[24h])) / sum by (name) (increase(gatus_results_total{${CATALOG}}[24h])))`;
const RATIO_30D = `(sum by (name) (increase(gatus_results_total{${CATALOG},success="true"}[30d])) / sum by (name) (increase(gatus_results_total{${CATALOG}}[30d])))`;

export const APP_HEALTH_SCORE = `
 (${RATIO_30D} == bool 1) * 10
 + (${RATIO_30D} != bool 1) * clamp_max(round(9 * ${RATIO_24H}), 9)`;

const APP_SCORE = `homelab:app_health_score or (${APP_HEALTH_SCORE})`;

// The router's own health check calls every model many times a day; every other caller is real use.
const REAL_USE = 'api_key_alias!="litellm-internal-health-check"';
// One count per finished router request: the +Inf bucket of its latency histogram (_count is unreliable).
const ROUTER_REQUESTS = `litellm_request_total_latency_metric_bucket{le="+Inf",${REAL_USE}}`;
// Each request's own end-to-end time, in seconds, over the last hour of real requests.
const requestTime = (q) => `histogram_quantile(${q}, sum by (model, le) (increase(litellm_request_total_latency_metric_bucket{${REAL_USE}}[1h])))`;
// Each request's mean decode speed, in tok/s. Speed is the inverse of time per token, so the 0.9
// quantile of time is the slow tail: "p90 104 tok/s" means 90% of requests decoded at least that fast.
const decodeSpeed = (q) => `1 / histogram_quantile(${q}, sum by (model_name, le) (increase(vllm:request_time_per_output_token_seconds_bucket[1h])))`;

export const Q = {
  ...MC9_QUERIES,
  ...BENCHMARK_Q,
  ...BENCHMARK_SOURCE_AGE_Q,
  appScore: APP_SCORE,
  // mc3 fleet list: the same per-name score, kept only for names with a Gatus series in the AI
  // catalog category (group "AI · UI" or "AI · API"). Q.appScore carries no group label to filter on.
  aiAppScore: `(${APP_SCORE}) and on (name) group by (name) (gatus_results_total{group=~"AI · .+"})`,
  uptime24h: `100 * sum(increase(gatus_results_total{${CATALOG},success="true"}[24h])) / sum(increase(gatus_results_total{${CATALOG}}[24h]))`,
  nodeCpu: `100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{${NODE},mode="idle"}[2m])))`,
  nodeCores: `count by (instance) (node_cpu_seconds_total{${NODE},mode="idle"})`,
  nodeMem: `100 * (1 - node_memory_MemAvailable_bytes{${NODE}} / node_memory_MemTotal_bytes{${NODE}})`,
  nodeMemTotal: `node_memory_MemTotal_bytes{${NODE}}`,
  nodeLoad: `node_load1{${NODE}}`,
  nodeTemp: `max by (instance) (node_hwmon_temp_celsius{${NODE}})`,
  nodeUptime: `time() - node_boot_time_seconds{${NODE}}`,
  // Busy % per accelerator (0-100), averaged over 5m. Its only label is `accelerator` (no
  // instance), so no reading maps to one node: mc1.js's GPU gauge shows the busiest one and
  // mc3's GPU tile shows their mean.
  acceleratorBusy: 'accelerator:busy_percent:avg5m',
  fsSize: `node_filesystem_size_bytes{${FS}}`,
  fsAvail: `node_filesystem_avail_bytes{${FS}}`,
  // Per-VLAN firewall event rate (apps PR #2214: a Cribl pipeline on the UniFi syslog source
  // derives this from the br<N> interface). Empty until that pipeline deploys — mc1.js falls
  // back to sample VLAN bubbles (site/lib/sampleData.js) until real series exist.
  vlanFwRate: 'sum by (vlan) (rate(unifi_vlan_fw_events_total[5m]))',
  llmState: 'max by (litellm_model_name) (litellm_deployment_state)',
  llmTokRate: 'sum by (model) (rate(litellm_output_tokens_metric_total[5m]))',
  // MC1 and MC3 model lists: a model is listed once it served a real request in the last 4d. An
  // hour with no request leaves the percentiles with no row for that model: idle, not an error.
  llmUsed4d: `sum by (model) (increase(${ROUTER_REQUESTS}[4d])) > 0`,
  llmRequests1h: `sum by (model) (increase(${ROUTER_REQUESTS}[1h]))`,
  llmRequestP50: requestTime(0.5),
  llmRequestP90: requestTime(0.9),
  llmRequestP99: requestTime(0.99),
  llmTtftP50: `histogram_quantile(0.5, sum by (model, le) (increase(litellm_llm_api_time_to_first_token_metric_bucket{${REAL_USE}}[1h])))`,
  llmDecodeP50: decodeSpeed(0.5),
  llmDecodeP90: decodeSpeed(0.9),
  llmDecodeP99: decodeSpeed(0.99),
  // Unix time of each model's last real request.
  llmLastRequest: `tlast_change_over_time(sum by (model) (${ROUTER_REQUESTS})[4d:1m])`,
  // mc3
  llmTokensToday: 'sum(increase(litellm_total_tokens_metric_total[24h]))',
  llmReqPerMin: 'sum(rate(litellm_proxy_total_requests_metric_total[5m])) * 60',
  // MC3 retains its averages; MC7 uses the router bucket histograms for percentiles.
  llmQueueSeconds: 'sum by (model) (increase(litellm_request_queue_time_seconds_sum[5m])) / sum by (model) (increase(litellm_request_queue_time_seconds_count[5m]))',
  llmLatencySeconds: 'sum by (model) (increase(litellm_llm_api_latency_metric_sum[5m])) / sum by (model) (increase(litellm_llm_api_latency_metric_count[5m]))',
  // mc3 accelerator anchors. The per-device exporters label each device's product name and host;
  // a DCGM series with no `accelerator` label belongs to gpu-primary, matching accelerator:busy_percent:avg5m.
  gpuModel: 'group by (accelerator, modelName, instance) (DCGM_FI_DEV_GPU_UTIL)',
  macChip: 'group by (accelerator, chip, instance) (macmon_gpu_usage_ratio)',
  // Each model's serving URL. mc3 matches the URL's host against the host of the device series above.
  llmApiBase: 'max by (litellm_model_name, api_base, api_provider) (litellm_deployment_state)',
  // Requests in flight per local inference server, and across the whole router.
  vllmRunning: 'sum by (instance) (vllm:num_requests_running)',
  llamaRunning: 'sum by (instance) (llamacpp:requests_processing)',
  routerInFlight: 'sum(litellm_in_flight_requests)',
  // MC8: retain caller dimensions only on the token edges; all other queries aggregate early.
  mc8InputRate: 'sum by (api_key_alias, team, model, api_provider, tag_telemetry_billing_class_local, tag_telemetry_billing_class_subscription, tag_telemetry_billing_class_paid, tag_telemetry_billing_class_free) (rate(litellm_input_tokens_metric_total{job="llm_router"}[5m]))',
  mc8OutputRate: 'sum by (api_key_alias, team, model, api_provider, tag_telemetry_billing_class_local, tag_telemetry_billing_class_subscription, tag_telemetry_billing_class_paid, tag_telemetry_billing_class_free) (rate(litellm_output_tokens_metric_total{job="llm_router"}[5m]))',
  mc8InputSourceTime: 'max by (api_key_alias, team, model, api_provider, tag_telemetry_billing_class_local, tag_telemetry_billing_class_subscription, tag_telemetry_billing_class_paid, tag_telemetry_billing_class_free) (tlast_over_time(litellm_input_tokens_metric_total{job="llm_router"}[5m]))',
  mc8OutputSourceTime: 'max by (api_key_alias, team, model, api_provider, tag_telemetry_billing_class_local, tag_telemetry_billing_class_subscription, tag_telemetry_billing_class_paid, tag_telemetry_billing_class_free) (tlast_over_time(litellm_output_tokens_metric_total{job="llm_router"}[5m]))',
  mc8InFlight: 'sum(litellm_in_flight_requests{job="llm_router"})',
  // increase() also counts a new series' first small bucket value; rate() skips it.
  mc8TtftP95: 'histogram_quantile(0.95, sum by (le) (increase(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router"}[5m])))',
  mc8Failures: 'sum by (model, api_provider) (increase(litellm_deployment_failure_responses_total{job="llm_router"}[1m]))',
  mc8Fallbacks: 'sum by (model, api_provider) (increase(litellm_deployment_failed_fallbacks_total{job="llm_router"}[1m]))',
  // Raw-series last sample times for the readings above, grouped like each reading.
  mc8InFlightSourceTime: 'max(tlast_over_time(litellm_in_flight_requests{job="llm_router"}[5m]))',
  mc8TtftSourceTime: 'max(tlast_over_time(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router"}[5m]))',
  mc8FailuresSourceTime: 'max by (model, api_provider) (tlast_over_time(litellm_deployment_failure_responses_total{job="llm_router"}[5m]))',
  mc8FallbacksSourceTime: 'max by (model, api_provider) (tlast_over_time(litellm_deployment_failed_fallbacks_total{job="llm_router"}[5m]))',
  // Provider spend series exist only after that provider is used, so router liveness is the freshness signal.
  mc8SpendSourceTime: 'max(tlast_over_time(litellm_spend_metric_total{job="llm_router"}[5m]))',
  // Subtract each series before aggregating, including series absent at the UTC month boundary.
  // A counter reset can leave a series below its baseline; clamp it at zero so it never subtracts spend.
  mc8SpendCents: '100 * sum(clamp_min(max_over_time(litellm_spend_metric_total{job="llm_router",api_provider="openrouter"}[31d]) - (max_over_time(litellm_spend_metric_total{job="llm_router",api_provider="openrouter"}[31d] @ (time() - (scalar(day_of_month()) - 1) * 86400 - time() % 86400)) or max_over_time(litellm_spend_metric_total{job="llm_router",api_provider="openrouter"}[31d]) * 0), 0))',
};
