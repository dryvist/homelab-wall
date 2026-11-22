import { expect, test } from '@playwright/test';
import { mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';

// Mac memory on the estate (mc1) and AI core (mc3) pages, from the macmon host series and the per-model
// resident memory. The fixture serves one Mac (the extra node) with real series; these cases prove a live
// Mac replaces its pending card, an absent series leaves it pending without an error, and each local model
// gets one bar on its host.

test('a Mac with macmon series shows its RAM and swap instead of a pending card', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture series only');
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');
  const mac = page.locator('#nodelist .node.mac');
  await expect(mac).toHaveCount(1);
  await expect(mac.locator('.nm')).toContainText('RAM 96.0/128.0 GB');
  await expect(mac.locator('.nm')).toContainText('SWAP 3.5 GB');
  await expect(mac.locator('.nm')).not.toContainText('METRICS PENDING');
});

test('a Mac whose macmon series is absent stays pending, with no error', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture series only');
  await mockFeeds(page, { emptyQuery: (q) => q.includes('macmon_memory_') });
  await page.goto('/mc1/?gl=2d');
  const mac = page.locator('#nodelist .node.mac');
  await expect(mac).toHaveCount(1);
  await expect(mac.locator('.nm')).toContainText('METRICS PENDING');
});

test('the AI core draws one memory bar per local model on each Mac', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture series only');
  await mockFeeds(page);
  await page.goto('/mc3/?gl=2d');
  const rows = page.locator('#modelMem .mm');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('node-d');
  await expect(rows.first()).toContainText('model-large');
  await expect(rows.first()).toContainText('58.0 GB');
  await expect(rows.nth(1)).toContainText('21.0 GB');
});

test('with no model memory series the AI core says so and draws no bars', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture series only');
  await mockFeeds(page, { emptyQuery: (q) => q.includes('process_resident_memory_bytes') });
  await page.goto('/mc3/?gl=2d');
  await expect(page.locator('#modelMem')).toContainText('NO LOCAL MODEL MEMORY');
  await expect(page.locator('#modelMem .mm')).toHaveCount(0);
});
