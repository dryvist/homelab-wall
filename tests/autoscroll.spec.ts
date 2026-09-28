import { expect, test } from '@playwright/test';
import { mockFeeds } from './fixture';

// stage.js's autoScroll() (site/lib/stage.js) should move document.scrollingElement.scrollTop
// when a slide's content is taller than the viewport, and stay put when it isn't.
test('mc1 auto-scrolls only when its content overflows the viewport', async ({ page }) => {
  await mockFeeds(page);
  await page.goto('/mc1/');
  await page.waitForFunction(() => document.readyState === 'complete');

  // Force overflow so the assertion doesn't depend on the current mc1 layout height.
  await page.evaluate(() => { document.body.style.minHeight = '300vh'; });
  await page.waitForTimeout(400);
  const scrolled = await page.evaluate(() => document.scrollingElement!.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  // Remove the forced overflow: scrollHeight collapses back to the viewport, so autoScroll's own
  // `max <= 0` guard must stop moving it (nothing left to prove the loop can no-op).
  await page.evaluate(() => { document.body.style.minHeight = ''; document.scrollingElement!.scrollTop = 0; });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
});
