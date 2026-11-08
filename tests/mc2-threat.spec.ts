import { expect, test } from '@playwright/test';
import { Q } from '../site/lib/queries.js';
import { mockFeeds, config } from './fixture';
import { wallUrl } from './panels-contract';

const MC2_QUERIES = [Q.mc2DropCountries, Q.mc2DenyRules];

test('mc2 renders country drop metrics, deny rules and 2D traffic arcs', async ({ page }) => {
  test.skip(!!wallUrl, 'uses the MC2 fixture responses');
  await page.addInitScript(() => {
    const windowWithCount = window as typeof window & { mc2ArcCalls: number };
    windowWithCount.mc2ArcCalls = 0;
    const draw = CanvasRenderingContext2D.prototype.quadraticCurveTo;
    CanvasRenderingContext2D.prototype.quadraticCurveTo = function (...args) {
      windowWithCount.mc2ArcCalls += 1;
      draw.apply(this, args);
    };
  });
  await mockFeeds(page);
  await page.goto('/mc2/?gl=2d');

  await expect(page.locator('#threat')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#blocked')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#threat .threat-stats b')).toHaveText(['37.8', '1,231', '5']);
  await expect(page.locator('#threat .rule-row > span')).toHaveText(['geo-deny', 'rate-limit', 'invalid-state']);
  await expect(page.locator('#blocked .country-code')).toHaveText(['US', 'BG', 'DE', 'NL', 'GB']);
  await expect(page.locator('#blocked .country-name')).toHaveText([
    'United States', 'Bulgaria', 'Germany', 'Netherlands', 'United Kingdom',
  ]);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { mc2ArcCalls: number }).mc2ArcCalls))
    .toBeGreaterThan(0);
});

test('mc2 keeps panels in no-feed and draws no arcs for empty metrics', async ({ page }) => {
  test.skip(!!wallUrl, 'returns empty MC2 metric responses from the fixture server');
  await page.addInitScript(() => {
    const windowWithCount = window as typeof window & { mc2ArcCalls: number };
    windowWithCount.mc2ArcCalls = 0;
    const draw = CanvasRenderingContext2D.prototype.quadraticCurveTo;
    CanvasRenderingContext2D.prototype.quadraticCurveTo = function (...args) {
      windowWithCount.mc2ArcCalls += 1;
      draw.apply(this, args);
    };
  });
  await mockFeeds(page, { emptyQuery: (query) => MC2_QUERIES.includes(query) });
  await page.goto('/mc2/?gl=2d');

  for (const selector of ['#threat', '#blocked']) {
    const panel = page.locator(selector);
    await expect(panel).toHaveAttribute('data-state', 'no-feed');
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"No feed"');
  }
  await expect.poll(() => page.evaluate(() => (window as typeof window & { mc2ArcCalls: number }).mc2ArcCalls))
    .toBe(0);
});

test('mc2 reports query errors and holds last readings as stale', async ({ page }) => {
  test.skip(!!wallUrl, 'changes MC2 metric responses against the fixture server');
  await mockFeeds(page);
  await page.route('**/config.json', (route) => route.fulfill({ json: { ...config, refreshSeconds: 1 } }));
  let failing = false;
  await page.route('**/api/prom/**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('query') || '';
    if (failing && MC2_QUERIES.includes(query)) {
      return route.fulfill({ status: 500, json: { status: 'error', error: 'forced failure' } });
    }
    return route.fallback();
  });
  await page.goto('/mc2/?gl=2d');
  await expect(page.locator('#threat')).toHaveAttribute('data-state', 'ok');

  failing = true;
  await expect(page.locator('#threat')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('#threat [data-panel-message]')).toHaveText('STALE');
  await expect(page.locator('#threat .threat-stats b').nth(1)).toHaveText('1,231');
  await expect(page.locator('#blocked')).toHaveAttribute('data-state', 'stale');

  failing = false;
  await expect(page.locator('#threat')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#blocked')).toHaveAttribute('data-state', 'ok');
});

test('mc2 shows query errors before any successful metric response', async ({ page }) => {
  test.skip(!!wallUrl, 'forces MC2 metric queries to fail against the fixture server');
  await mockFeeds(page, { failQuery: (query) => MC2_QUERIES.includes(query) });
  await page.goto('/mc2/?gl=2d');

  for (const selector of ['#threat', '#blocked']) {
    const panel = page.locator(selector);
    await expect(panel).toHaveAttribute('data-state', 'error');
    await expect(panel.locator('[data-panel-message]')).toHaveText('query 500');
  }
});
