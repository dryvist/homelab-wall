// Test data only; these values never ship in the page.
import type { Page, Route } from '@playwright/test';
import { Q } from '../site/lib/queries.js';

export const mc9Rates: Record<string, [Record<string, string>, number][]> = {
  mc9DonnaRate: [[{}, .1]],
  mc9HindsightRate: [[{}, 0]],
  mc9CodexRate: [[{}, 12], [{ backend: 'subagents' }, 4]],
  mc9ClaudeMainRate: [[{}, 8]],
  mc9ClaudeSubagentRate: [[{}, 0]],
  mc9SpanRate: [],
};

export async function mockMC9(page: Page, options: { empty?: boolean; fail?: boolean; failHistory?: boolean; refreshSeconds?: number } = {}) {
  await page.route('**/config.json', (route: Route) => route.fulfill({ json: { refreshSeconds: options.refreshSeconds ?? 15 } }));
  await page.route('**/api/prom/**', (route: Route) => {
    const url = new URL(route.request().url());
    const key = Object.keys(mc9Rates).find((k) => Q[k] === url.searchParams.get('query'));
    const history = url.pathname.endsWith('query_range');
    if (options.fail || (history && options.failHistory)) return route.fulfill({ status: 500, body: 'fixture failure' });
    const end = Number(url.searchParams.get('end')) || Date.now() / 1000;
    const rows = options.empty ? [] : mc9Rates[key || ''] || [];
    const result = rows.map(([metric, value]) => history ? {
      metric,
      // An omitted sample is a real gap, including in the ring test.
      values: Array.from({ length: 289 }, (_, i) => [end - (288 - i) * 300, String(value)])
        .filter((_, i) => i !== 120),
    } : { metric, value: [end, String(value)] });
    return route.fulfill({ json: { status: 'success', data: { resultType: history ? 'matrix' : 'vector', result } } });
  });
}
