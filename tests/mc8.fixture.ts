// Test fixtures only; none of these sample values are shipped in the page.
import type { Page } from '@playwright/test';
import { Q } from '../site/lib/queries.js';

const billing = (bank: string): Record<string, string> => Object.fromEntries(
  ['local', 'subscription', 'paid', 'free'].map((key) => [`tag_telemetry_billing_class_${key}`, String(key === bank)]),
);
type TokenFixtureRow = { labels: Record<string, string>; input: number; output: number };
export const tokenRows = [
  { labels: { api_key_alias: 'caller-a', team: 'engineering', model: 'local-model', api_provider: 'hosted_vllm', ...billing('local') }, input: 60, output: 30 },
  { labels: { api_key_alias: 'caller-b', team: 'automation', model: 'subscription-model', api_provider: 'openai', ...billing('subscription') }, input: 20, output: 5 },
  { labels: { api_key_alias: 'caller-a', team: 'engineering', model: 'paid-model', api_provider: 'openai', ...billing('paid') }, input: 10, output: 5 },
];

export const highCardinalityRows: TokenFixtureRow[] = Array.from({ length: 20 * 12 }, (_, index) => {
  const caller = index % 20;
  const model = Math.floor(index / 20);
  const banks = ['local', 'subscription', 'paid', 'free', 'unknown'];
  return {
    labels: {
      api_key_alias: `caller-${String(caller + 1).padStart(2, '0')}`,
      team: `team-${String(caller + 1).padStart(2, '0')}`,
      model: `model-${String(model + 1).padStart(2, '0')}`,
      api_provider: `provider-${model % 3 + 1}`,
      ...billing(banks[model % banks.length]),
    },
    input: 1 + caller * 2 + model,
    output: 1 + model * 2,
  };
});

export function mc8Answer(expr: string, rows: TokenFixtureRow[] = tokenRows) {
  const vec = (answers: Array<[Record<string, string>, number]>) => answers.map(([metric, value]) => ({ metric, value: [Date.now() / 1000, String(value)] }));
  const modelRows = [...new Map(rows.map((row) => [JSON.stringify([row.labels.model, row.labels.api_provider]), row.labels])).values()];
  const classRows = [...new Map(rows.map((row) => [JSON.stringify([row.labels.model, row.labels.tag_telemetry_billing_class_local]), {
    model: row.labels.model || 'Unlabelled model', ...(row.labels.tag_telemetry_billing_class_local ? { tag_telemetry_billing_class_local: row.labels.tag_telemetry_billing_class_local } : {}),
  }])).values()];
  const classLabels = [...new Map(rows.map((row) => [row.labels.tag_telemetry_billing_class_local || 'cloud',
    row.labels.tag_telemetry_billing_class_local ? { tag_telemetry_billing_class_local: row.labels.tag_telemetry_billing_class_local } : {}])).values()];
  // Raw counter sample times: freshness reads each source value as that sample's time in seconds.
  if (expr === Q.mc8InputSourceTime || expr === Q.mc8OutputSourceTime) return vec(rows.map((row) => [row.labels, Date.now() / 1000]));
  if (expr === Q.mc8RequestsSourceTime) return vec(classLabels.map((labels) => [labels, Date.now() / 1000]));
  if ([Q.mc8RequestLatencyLocalSourceTime, Q.mc8RequestLatencyCloudSourceTime].includes(expr)) return vec([[{}, Date.now() / 1000]]);
  if ([Q.mc8Failures15mSourceTime, Q.mc8Fallbacks15mSourceTime].includes(expr)) return vec(classLabels.map((labels) => [labels, Date.now() / 1000]));
  if (expr === Q.mc8TopModelsLocalSourceTime) return vec(classRows.filter((labels) => labels.tag_telemetry_billing_class_local === 'true').map((labels) => [labels, Date.now() / 1000]));
  if (expr === Q.mc8TopModelsCloudSourceTime) return vec(classRows.filter((labels) => labels.tag_telemetry_billing_class_local !== 'true').map((labels) => [labels, Date.now() / 1000]));
  if ([Q.mc8InFlightSourceTime, Q.mc8SpendSourceTime, Q.mc8TtftLocalSourceTime, Q.mc8TtftCloudSourceTime,
    Q.mc8VllmSourceTime, Q.mc8LlamaSourceTime].includes(expr)) return vec([[{}, Date.now() / 1000]]);
  if (expr === Q.mc8FailuresSourceTime || expr === Q.mc8FallbacksSourceTime) return vec(modelRows.map((m) => [{ model: m.model, api_provider: m.api_provider }, Date.now() / 1000]));
  if (expr === Q.mc8InputRate) return vec(rows.map((row) => [row.labels, row.input]));
  if (expr === Q.mc8OutputRate) return vec(rows.map((row) => [row.labels, row.output]));
  if (expr === Q.mc8RequestsPerMinute) return vec([[{ tag_telemetry_billing_class_local: 'true' }, 3], [{ tag_telemetry_billing_class_local: 'false' }, 5]]);
  if (expr === Q.mc8RequestLatencyLocalP50) return vec([[{}, 0.12]]);
  if (expr === Q.mc8RequestLatencyCloudP50) return vec([[{}, 0.24]]);
  if (expr === Q.mc8RequestLatencyLocalP95) return vec([[{}, 0.36]]);
  if (expr === Q.mc8RequestLatencyCloudP95) return vec([[{}, 0.48]]);
  if (expr === Q.mc8Failures15m) return vec([[{ tag_telemetry_billing_class_local: 'true' }, 1], [{ tag_telemetry_billing_class_local: 'false' }, 2]]);
  if (expr === Q.mc8Fallbacks15m) return vec([[{ tag_telemetry_billing_class_local: 'true' }, 0], [{ tag_telemetry_billing_class_local: 'false' }, 1]]);
  if (expr === Q.mc8TopModelsLocal) return vec([[{ model: 'local-model', tag_telemetry_billing_class_local: 'true' }, 17]]);
  if (expr === Q.mc8TopModelsCloud) return vec([[{ model: 'subscription-model', tag_telemetry_billing_class_local: 'false' }, 12], [{ model: 'paid-model', tag_telemetry_billing_class_local: 'false' }, 8]]);
  if (expr === Q.vllmRunning) return vec([[{}, 2]]);
  if (expr === Q.llamaRunning) return vec([[{}, 1]]);
  if (expr === Q.mc8InFlight) return vec([[{}, 7]]);
  if (expr === Q.mc8SpendCents) return vec([[{}, 123.4]]);
  if (expr === Q.mc8TtftLocalP95) return vec([[{}, 0.21]]);
  if (expr === Q.mc8TtftCloudP95) return vec([[{}, 0.42]]);
  if (expr === Q.mc8Failures || expr === Q.mc8Fallbacks) return vec(modelRows.map((m) => [{ model: m.model, api_provider: m.api_provider }, 0]));
  return [];
}

export async function mockMc8(page: Page, opts: { empty?: boolean; fail?: () => boolean; snapshot?: boolean; failure?: boolean; fallback?: boolean; idleTtft?: boolean; rows?: TokenFixtureRow[]; pinnedCallers?: string[] } = {}) {
  const rows = opts.rows || tokenRows;
  await page.route('**/config.json', (r) => r.fulfill({ json: { refreshSeconds: 1, ...(opts.snapshot ? { snapshot: '/data/mc8.json' } : {}), ...(opts.pinnedCallers ? { mc8PinnedCallers: opts.pinnedCallers } : {}) } }));
  await page.route('**/api/prom/query?**', (r) => {
    if (opts.fail?.()) return r.fulfill({ status: 500, json: { status: 'error' } });
    const expr = new URL(r.request().url()).searchParams.get('query') || '';
    const result = mc8Answer(expr, rows);
    if ((opts.failure && expr === Q.mc8Failures) || (opts.fallback && expr === Q.mc8Fallbacks)) {
      result[0].value[1] = '1';
    }
    // idleTtft: no TTFT requests in the window, while the histogram's sample time stays fresh.
    const none = opts.empty || (opts.idleTtft && [Q.mc8TtftLocalP95, Q.mc8TtftCloudP95].includes(expr));
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: none ? [] : result } } });
  });
  await page.route('**/data/mc8.json', (r) => r.fulfill({ json: {
    generated_at: new Date().toISOString(),
    instant: Object.fromEntries(Object.entries(Q).filter(([key]) => key.startsWith('mc8') || ['vllmRunning', 'llamaRunning'].includes(key))
      .map(([key, expr]) => [key, { result: mc8Answer(expr, rows) }])),
  } }));
}
