// Only bounded role labels leave Prometheus. Source/session/user labels stay there.
const codex = 'codex_turn_token_usage_sum{token_type="output"}';
const byRole = (metric, label, pattern) =>
  `sum by (backend) (label_replace(rate(${metric}[5m]), "backend", "subagents", "${label}", "${pattern}"))`;

export const MC9_QUERIES = {
  // Instance gauges, read as each instance's peak over the same 5 minutes the rates use, so a short run still shows.
  mc9GatewayAgents: 'sum(max_over_time(hermes_gateway_active_agents[5m]))',
  mc9CronJobs: 'sum(max_over_time(hermes_cron_jobs_running[5m]))',
  mc9DonnaRate: 'sum(rate(litellm_proxy_total_requests_metric_total{api_key_alias="donna"}[5m]))',
  mc9HindsightRate: 'sum(rate(hindsight_operation_operations_total[5m]))',
  mc9CodexRate: byRole(codex, 'session_source', 'subagent_.*'),
  // A named main agent belongs in the primary node; every other named agent is a satellite.
  mc9ClaudeMainRate: 'sum(rate(claude_code_token_usage_total{type="output",agent_name=~"main|"}[5m]))',
  mc9ClaudeSubagentRate: 'sum(rate(claude_code_token_usage_total{type="output",agent_name!~"main|"}[5m]))',
};
