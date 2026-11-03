import { expect, test } from '@playwright/test';
import pending from './expected-pending.json' with { type: 'json' };
import { Q } from '../site/lib/queries.js';

const wallUrl = process.env.WALL_URL;

test('live Prometheus queries return series unless explicitly pending', async ({ request }) => {
  test.skip(!wallUrl, 'WALL_URL enables the live suite');
  const expected = new Set<string>(pending.queries);
  for (const [name, expression] of Object.entries(Q)) {
    const response = await request.get(`${wallUrl}/api/prom/query`, { params: { query: expression } });
    expect(response.ok(), name).toBe(true);
    const body = await response.json() as { readonly data?: { readonly result?: readonly unknown[] } };
    if (!expected.has(name)) expect(body.data?.result?.length, name).toBeGreaterThan(0);
  }
});

// mc6's own feed: ClickHouse FORMAT JSON on the same origin, independent of /api/prom.
test('live /api/words returns rows for the lexicon', async ({ request }) => {
  test.skip(!wallUrl, 'WALL_URL enables the live suite');
  const response = await request.get(`${wallUrl}/api/words`);
  expect(response.ok(), 'words').toBe(true);
  const body = await response.json() as { readonly data?: readonly unknown[] };
  expect(Array.isArray(body.data), 'words').toBe(true);
  expect(body.data?.length, 'words').toBeGreaterThan(0);
});
