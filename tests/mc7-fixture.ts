import type { Page } from '@playwright/test';
import { Q } from '../site/lib/queries.js';
import { BENCHMARK_SOURCE_AGE_FOR } from '../site/lib/benchmarkQueries.js';
import fixtures from './mc7-fixtures.json' with { type: 'json' };

type Labels = Record<string, string | undefined>;
const readingRows: Record<string, Array<{ labels: Labels }>> = fixtures;
const AGE_KEYS = [...new Set(Object.values(BENCHMARK_SOURCE_AGE_FOR))];

// Label sets of every reading an age query feeds, de-duplicated; the age query groups the same way.
function ageRows(ageKey: string): Labels[] {
  const seen = new Map<string, Labels>();
  for (const [reading, key] of Object.entries(BENCHMARK_SOURCE_AGE_FOR)) {
    if (key !== ageKey) continue;
    for (const row of readingRows[reading] ?? []) seen.set(JSON.stringify(row.labels), row.labels);
  }
  return [...seen.values()];
}

// Test responses only; the page imports no fixture data.
export async function mockMc7(page: Page, options: { empty?: boolean; error?: boolean; snapshot?: boolean } = {}) {
  await page.route('**/config.json', (r) => r.fulfill({ json: {
    refreshSeconds: 1, ...(options.snapshot ? { snapshot: '/mc7-snapshot.json' } : {}),
  } }));
  const vectors = () => Object.fromEntries(Object.entries(fixtures).map(([key, rows]) => [key, {
    result: options.empty ? [] : rows.map((row) => ({ metric: row.labels, value: [Date.now() / 1000, String(row.value)] })),
  }]));
  // A source sample taken now: the age query's value is that sample's time in seconds.
  const ages = () => Object.fromEntries(AGE_KEYS.map((ageKey) => [ageKey, {
    result: options.empty ? [] : ageRows(ageKey).map((labels) => ({ metric: labels, value: [Date.now() / 1000, String(Date.now() / 1000)] })),
  }]));
  const matrices = (start: number, end: number, step: number) => Object.fromEntries(Object.entries(fixtures).map(([key, rows]) => [key, {
    result: options.empty ? [] : rows.map((row) => ({ metric: row.labels,
      values: Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => [start + i * step, String(row.value)]),
    })),
  }]));
  await page.route('**/mc7-snapshot.json', (r) => {
    if (options.error) return r.fulfill({ status: 500 });
    const end = Math.floor(Date.now() / 1000 / 15) * 15;
    return r.fulfill({ json: { instant: { ...vectors(), ...ages() }, range: matrices(end - 600, end, 15) } });
  });
  await page.route('**/api/prom/**', (r) => {
    if (options.error) return r.fulfill({ status: 500, json: { status: 'error' } });
    const url = new URL(r.request().url()), params = url.searchParams;
    const ageKey = AGE_KEYS.find((key) => Q[key] === params.get('query'));
    if (ageKey) return r.fulfill({ json: { status: 'success', data: { result: ages()[ageKey].result } } });
    const key = Object.keys(fixtures).find((key) => Q[key] === params.get('query'));
    const source = url.pathname.endsWith('query_range')
      ? matrices(Number(params.get('start')), Number(params.get('end')), Number(params.get('step')))
      : vectors();
    return r.fulfill({ json: { status: 'success', data: { result: key ? source[key].result : [] } } });
  });
}
