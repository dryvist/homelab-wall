import { test, expect } from '@playwright/test';
import { mockFeeds, config } from './fixture';

test('mission control 1 renders every panel from live-shaped data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await mockFeeds(page);
  await page.goto('/mc1/');

  // 3 live nodes + 1 pending extra node
  await expect(page.locator('.node')).toHaveCount(4);
  await expect(page.locator('#quorum')).toHaveText('3/4 UP');
  await expect(page.locator('#strows .st')).toHaveCount(6);
  await expect(page.locator('#llmrows .lr')).toHaveCount(3);
  await expect(page.locator('#appsum')).toContainText('1 DOWN');
  await expect(page.locator('#labels .vl')).toHaveCount(config.groups.length);
  await expect(page.locator('#kpis')).toContainText('99.93');

  // the honeycomb canvas actually painted something
  const painted = await page.locator('#hex').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(10_000);

  await page.waitForTimeout(2500); // let gauges and hexes settle on their values
  await page.screenshot({ path: 'test-results/mc1-2d.png' });
  expect(errors).toEqual([]);
});

test('3D topology renders when forced', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockFeeds(page);
  await page.goto('/mc1/?gl=3d');
  await expect(page.locator('#topostate')).toHaveText('LIVE');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/mc1-3d.png' });
  expect(errors).toEqual([]);
});

test('falls back to 2D when WebGL is a software renderer', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test shim: report no WebGL at all
    HTMLCanvasElement.prototype.getContext = function (t: string, ...a: unknown[]) { return t === 'webgl' ? null : orig.call(this, t, ...a); };
  });
  await mockFeeds(page);
  await page.goto('/mc1/');
  await expect(page.locator('#topostate')).toHaveText('2D MODE');
});
