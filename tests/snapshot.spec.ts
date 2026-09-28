// Proves site/lib/prom.js's snapshot source (config.json "snapshot") resolves every Q.* query
// from one polled JSON, with zero requests ever reaching /api/prom — the public deployment's
// whole point: nothing may call back into the gateway at request time.
import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { Q } from '../site/lib/queries.js';
import { config, answer } from './fixture';

const wallUrl = process.env.WALL_URL;

// Builds a snapshot.json shaped exactly as homelab-wall-feed's publisher writes it: one entry
// per Q key (never per raw expression), instant queries under `instant`, range under `range`,
// each `{result: [...]}` in Prometheus's own vector/matrix shape — reusing fixture.ts's `answer()`
// so this fixture can't drift from the live-mode one.
function buildSnapshot() {
  const instant: Record<string, { result: unknown[] }> = {};
  const range: Record<string, { result: unknown[] }> = {};
  for (const [key, expr] of Object.entries(Q)) {
    const rows = answer(expr) as Array<{ metric: Record<string, string>; value: [number, string] }>;
    instant[key] = { result: rows };
    range[key] = {
      result: rows.map((r) => ({
        metric: r.metric,
        values: Array.from({ length: 60 }, (_, k) => [k, String(20 + ((k * 7) % 50))]),
      })),
    };
  }
  return { generated_at: new Date().toISOString(), instant, range };
}

async function mockSnapshotFeeds(page: import('@playwright/test').Page) {
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: { ...config, snapshot: '/data/snapshot.json' } }));
  await page.route('**/data/snapshot.json', (r: Route) => r.fulfill({ json: buildSnapshot() }));
}

const PAGES = ['mc1', 'mc2', 'mc3', 'mc4', 'mc5'] as const;

for (const id of PAGES) {
  test(`${id} resolves every query from the snapshot, never calling /api/prom`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture snapshot only');
    const promCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/prom/')) promCalls.push(req.url());
    });
    await mockSnapshotFeeds(page);
    await page.goto(`/${id}/`);
    const panels = page.locator('[data-panel]');
    await expect(panels).not.toHaveCount(0);
    // Web-first: every panel resolves out of 'pending' once the snapshot answers it (mc1's
    // "nodes" panel stays pending for an unrelated reason — see panels.spec.ts — so it's excluded
    // here rather than widening the wait).
    const count = await panels.count();
    for (let i = 0; i < count; i += 1) {
      const panel = panels.nth(i);
      if (id === 'mc1' && (await panel.getAttribute('data-panel')) === 'nodes') continue;
      await expect(panel).not.toHaveAttribute('data-state', 'pending');
    }
    expect(promCalls, 'snapshot mode must never call /api/prom').toEqual([]);
  });
}
