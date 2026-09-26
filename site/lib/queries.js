// PromQL used by the wall. APP_HEALTH_SCORE is the single base definition of
// the 0-9(-10) app health score; prometheus-homelab-rules records the identical
// expression as homelab:app_health_score, which Q.appScore prefers once it exists.
//
// KNOWN GAP: that precomputed metric is defined in a separate repo and still encodes the old
// 0-100 formula. Q.appScore's "or" prefers it when present, so the live wall keeps showing 0-100
// values until that definition is updated to match this expression — this file alone cannot fix it.
const CATALOG = 'group=~"catalog-.+",group!="catalog-authed"';
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
