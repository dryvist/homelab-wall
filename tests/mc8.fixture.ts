// Test fixtures only; none of these sample values are shipped in the page.
import type { Page } from '@playwright/test';
import { Q } from '../site/lib/queries.js';

const billing = (bank: string): Record<string, string> => Object.fromEntries(
  ['local', 'subscription', 'paid', 'free'].map((key) => [`tag_telemetry_billing_class_${key}`, String(key === bank)]),
);
export const tokenRows = [
  { api_key_alias: 'caller-a', team: 'engineering', model: 'local-model', api_provider: 'hosted_vllm', ...billing('local') },
  { api_key_alias: 'caller-b', team: 'automation', model: 'subscription-model', api_provider: 'openai', ...billing('subscription') },
  { api_key_alias: 'caller-a', team: 'engineering', model: 'paid-model', api_provider: 'openai', ...billing('paid') },
];

export function mc8Answer(expr: string) {
  const vec = (rows: Array<[Record<string, string>, number]>) => rows.map(([metric, value]) => ({ metric, value: [Date.now() / 1000, String(value)] }));
  // Raw counter sample times: freshness reads each source value as that sample's time in seconds.
  if (expr === Q.mc8InputSourceTime || expr === Q.mc8OutputSourceTime) return vec(tokenRows.map((m) => [m, Date.now() / 1000]));
  if (expr === Q.mc8InFlightSourceTime || expr === Q.mc8SpendSourceTime || expr === Q.mc8TtftSourceTime) return vec([[{}, Date.now() / 1000]]);
  if (expr === Q.mc8FailuresSourceTime || expr === Q.mc8FallbacksSourceTime) return vec(tokenRows.map((m) => [{ model: m.model, api_provider: m.api_provider }, Date.now() / 1000]));
  if (expr === Q.mc8InputRate) return vec(tokenRows.map((m, i) => [m, [60, 20, 10][i]]));
  if (expr === Q.mc8OutputRate) return vec(tokenRows.map((m, i) => [m, [30, 5, 5][i]]));
  if (expr === Q.mc8InFlight) return vec([[{}, 7]]);
  if (expr === Q.mc8SpendCents) return vec([[{}, 123.4]]);
  if (expr === Q.mc8TtftP95) return vec([[{}, 0.42]]);
  if (expr === Q.mc8Failures || expr === Q.mc8Fallbacks) return vec(tokenRows.map((m) => [{ model: m.model, api_provider: m.api_provider }, 0]));
  return [];
}

export async function mockMc8(page: Page, opts: { empty?: boolean; fail?: () => boolean; snapshot?: boolean; failure?: boolean; fallback?: boolean; idleTtft?: boolean } = {}) {
  await page.route('**/config.json', (r) => r.fulfill({ json: { refreshSeconds: 1, ...(opts.snapshot ? { snapshot: '/data/mc8.json' } : {}) } }));
  await page.route('**/api/prom/query?**', (r) => {
    if (opts.fail?.()) return r.fulfill({ status: 500, json: { status: 'error' } });
    const expr = new URL(r.request().url()).searchParams.get('query') || '';
    const result = mc8Answer(expr);
    if ((opts.failure && expr === Q.mc8Failures) || (opts.fallback && expr === Q.mc8Fallbacks)) {
      result[0].value[1] = '1';
    }
    // idleTtft: no TTFT requests in the window, while the histogram's sample time stays fresh.
    const none = opts.empty || (opts.idleTtft && expr === Q.mc8TtftP95);
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: none ? [] : result } } });
  });
  await page.route('**/data/mc8.json', (r) => r.fulfill({ json: {
    generated_at: new Date().toISOString(),
    instant: Object.fromEntries(Object.entries(Q).filter(([key]) => key.startsWith('mc8')).map(([key, expr]) => [key, { result: mc8Answer(expr) }])),
  } }));
}
