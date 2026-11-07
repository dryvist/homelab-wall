import { expect, test } from '@playwright/test';
import { SLIDES, mockSlides, watchFaults, activeSlideUrl } from './fixture';

// Track: the wall reloads itself periodically so a new release appears without anyone touching
// the kiosk. `?reloadms=` (this file only, never read by real config) shortens the interval so
// the test doesn't wait out the real 60-minute default. A page-level marker (set via evaluate,
// which targets the main frame only) disappearing proves the top document actually reloaded —
// simpler and less frame-ambiguous than listening for `beforeunload`, which also fires on each
// slide iframe's own first navigation. The reload itself tears down the page's execution
// context mid-poll, so the polled predicate treats that teardown as "gone" too.
async function markerGone(page: import('@playwright/test').Page) {
  try {
    return (await page.evaluate(() => (window as any).__marker)) === undefined;
  } catch {
    return true; // execution context destroyed by the reload navigation
  }
}

test('the page reloads after the configured interval', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page);
  await page.goto('/?reloadms=10000');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.evaluate(() => { (window as any).__marker = 'alive'; });

  await page.clock.fastForward(9_000);
  expect(await markerGone(page)).toBe(false);

  await page.clock.fastForward(2_000);
  await expect.poll(() => markerGone(page)).toBe(true);
});

test('reloadMinutes from /config.json overrides the default interval', async ({ page }) => {
  await page.clock.install();
  // MIN_RELOAD_MINUTES clamps below 5, so 5 is the shortest real interval this can exercise.
  await page.route('**/config.json', (r) => r.fulfill({ json: { slides: SLIDES, holdSeconds: 30, reloadMinutes: 5 } }));
  for (const s of SLIDES) {
    await page.route(`**${s.url}`, (r) => r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>${s.name}</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
    }));
  }
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.evaluate(() => { (window as any).__marker = 'alive'; });

  await page.clock.fastForward(4 * 60_000 + 59_000); // reloadMinutes: 5 -> 300_000ms, not yet due
  expect(await markerGone(page)).toBe(false);

  await page.clock.fastForward(2_000);
  await expect.poll(() => markerGone(page)).toBe(true);
});

test('no console errors across a full run', async ({ page }) => {
  const faults = watchFaults(page);
  await page.clock.install();
  await mockSlides(page);
  await page.goto('/');
  await page.mouse.move(10, 10);
  await page.keyboard.press('ArrowRight');
  await page.clock.fastForward(10_000);
  await page.keyboard.press('p');
  await page.keyboard.press('p');
  expect(faults).toEqual([]);
});

for (const size of [{ width: 1280, height: 720 }, { width: 2560, height: 1440 }]) {
  test(`no scroll at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await mockSlides(page);
    await page.goto('/');
    const overflow = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth <= window.innerWidth,
      h: document.documentElement.scrollHeight <= window.innerHeight,
    }));
    expect(overflow.w).toBe(true);
    expect(overflow.h).toBe(true);
  });
}

// Track: self-heal — a reload must never navigate into a dead origin. The preflight fetch fires
// from inside a page.clock-fastForwarded timer callback and targets the exact page URL; that
// specific combination doesn't reliably surface to page.route() (a Playwright/Chromium quirk with
// no bearing on the real kiosk, which never runs under a fake clock or request interception) — so
// this replaces window.fetch itself, keyed on the preflight's own distinguishing option
// (`redirect: 'manual'`, which nothing else in rotator.js passes), giving deterministic control
// over exactly that one call without touching the network layer at all.
test('reload preflight blocks navigation on a 500 and proceeds once the origin recovers', async ({ page }) => {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    (window as any).__preflightHealthy = false;
    (window as any).__preflightCount = 0;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === 'manual') {
        (window as any).__preflightCount += 1;
        if (!(window as any).__preflightHealthy) {
          return Promise.resolve(new Response('origin down', { status: 500 }));
        }
      }
      return realFetch(input as any, init);
    }) as typeof fetch;
  });
  await page.clock.install();
  await mockSlides(page);

  await page.goto('/?reloadms=10000');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.evaluate(() => { (window as any).__marker = 'alive'; });

  await page.clock.fastForward(10_000); // reload timer fires; preflight gets a 500
  await expect.poll(() => page.evaluate(() => (window as any).__preflightCount)).toBeGreaterThan(0);
  expect(await markerGone(page)).toBe(false); // did not navigate away

  await page.evaluate(() => { (window as any).__preflightHealthy = true; });
  await page.clock.fastForward(60_000); // RELOAD_RETRY_MS
  await expect.poll(() => markerGone(page)).toBe(true); // now reloads
});
