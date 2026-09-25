// PromQL used by the wall. APP_HEALTH_SCORE is the single base definition of
// the 0-100 app health score; prometheus-homelab-rules records the identical
// expression as homelab:app_health_score, which Q.appScore prefers once it exists.
const CATALOG = 'group=~"catalog-.+",group!="catalog-authed"';
const NODE = 'job="pve_node_exporter"';
const FS = `${NODE},fstype!~"tmpfs|devtmpfs|overlay|squashfs|ramfs|fuse.*|nsfs|efivarfs|vfat"`;

export const APP_HEALTH_SCORE = `100
 * (sum by (name) (increase(gatus_results_total{${CATALOG},success="true"}[24h]))
    / sum by (name) (increase(gatus_results_total{${CATALOG}}[24h]))) ^ 2
 * clamp(1 - (max by (name) (quantile_over_time(0.95, gatus_results_duration_seconds{${CATALOG}}[1h])) - 0.25) / 2, 0.5, 1)
 * max by (name) (gatus_results_endpoint_success{${CATALOG}})`;

export const Q = {
  appScore: `homelab:app_health_score or (${APP_HEALTH_SCORE})`,
  uptime24h: `100 * sum(increase(gatus_results_total{${CATALOG},success="true"}[24h])) / sum(increase(gatus_results_total{${CATALOG}}[24h]))`,
  nodeCpu: `100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{${NODE},mode="idle"}[2m])))`,
  nodeCores: `count by (instance) (node_cpu_seconds_total{${NODE},mode="idle"})`,
  nodeMem: `100 * (1 - node_memory_MemAvailable_bytes{${NODE}} / node_memory_MemTotal_bytes{${NODE}})`,
  nodeMemTotal: `node_memory_MemTotal_bytes{${NODE}}`,
  nodeLoad: `node_load1{${NODE}}`,
  nodeTemp: `max by (instance) (node_hwmon_temp_celsius{${NODE}})`,
  nodeUptime: `time() - node_boot_time_seconds{${NODE}}`,
  fsSize: `node_filesystem_size_bytes{${FS}}`,
  fsAvail: `node_filesystem_avail_bytes{${FS}}`,
  llmState: 'max by (litellm_model_name) (litellm_deployment_state)',
  llmTokRate: 'sum by (model) (rate(litellm_output_tokens_metric_total[5m]))',
  // mc3
  llmTokensToday: 'sum(increase(litellm_total_tokens_metric_total[24h]))',
  llmReqPerMin: 'sum(rate(litellm_proxy_total_requests_metric_total[5m])) * 60',
};
