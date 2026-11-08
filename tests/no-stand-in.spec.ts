import { expect, test, type Page } from '@playwright/test';
import { fixturePools, mockFeeds } from './fixture';
import { mockMc7 } from './mc7-fixture';
import { mockMc8 } from './mc8.fixture';
import { mockMC9 } from './mc9.fixture';
import { wallUrl } from './panels-contract';

async function openFixture(page: Page, id: string) {
  if (id === 'mc7') {
    await mockMc7(page);
    await page.goto('/mc7/');
  } else if (id === 'mc8') {
    await mockMc8(page);
    await page.goto('/mc8/');
  } else if (id === 'mc9') {
    await mockMC9(page);
    await page.goto('/mc9/');
  } else {
    await mockFeeds(page);
    await page.goto(`/${id}/?gl=2d`);
  }
}

for (const id of ['mc1', 'mc2', 'mc3', 'mc4', 'mc5', 'mc6', 'mc7', 'mc8', 'mc9']) {
  test(`${id} renders no stand-in source marker with its fixture`, async ({ page }) => {
    test.skip(!!wallUrl, 'uses the dashboard fixture responses');
    await openFixture(page, id);
    await expect(page.locator('[data-source="stand-in"]')).toHaveCount(0);
  });
}

for (const { id, selectors } of [
  { id: 'mc2', selectors: ['#threat', '#blocked'] },
  { id: 'mc5', selectors: ['#infra'] },
]) {
  test(`${id} panels without a feed show the visible no-feed state`, async ({ page }) => {
    test.skip(!!wallUrl, 'uses the dashboard fixture responses');
    await openFixture(page, id);
    for (const selector of selectors) {
      const panel = page.locator(selector);
      await expect(panel).toHaveAttribute('data-state', 'no-feed');
      await expect.poll(() => panel.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"No feed"');
    }
  });
}

test('mc1 lists every storage pool, maps each GPU to its node, and orders nodes in reverse', async ({ page }) => {
  test.skip(!!wallUrl, 'uses the fixture-shaped MC1 metric responses');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    const w = window as unknown as { gpuReadings: Record<string, string> };
    w.gpuReadings = {};
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, ...args: Parameters<CanvasRenderingContext2D['fillText']>) {
      const id = this.canvas.id, label = String(args[0]);
      if (/^g\d+3$/.test(id) && (label === 'NO GPU' || /^(\d+(\.\d+)?|—)$/.test(label))) w.gpuReadings[id] = label;
      fillText.apply(this, args);
    };
  });
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');

  const rows = page.locator('#strows .st:not(.more) > span:first-child');
  for (const pool of fixturePools) await expect(rows.filter({ hasText: `${pool.node} ${pool.name}` })).toHaveCount(1);

  const nodeNames = await page.locator('#nodelist .node .nm').evaluateAll((els) =>
    els.map((el) => el.childNodes[0]?.textContent?.trim() ?? ''));
  const configuredNodes = nodeNames.filter((name) => ['NODE-A', 'NODE-B', 'NODE-C'].includes(name));
  expect(configuredNodes).toEqual(['NODE-C', 'NODE-B', 'NODE-A']);
  expect(configuredNodes).toEqual([...configuredNodes].sort((a, b) => b.localeCompare(a)));
  expect(nodeNames[nodeNames.length - 1]).toBe('NODE-D');
  await expect.poll(() => page.evaluate(() => (window as unknown as { gpuReadings: Record<string, string> }).gpuReadings), { timeout: 15_000 })
    .toMatchObject({ g03: 'NO GPU', g13: '64', g23: '36', g33: 'NO GPU' });
});

