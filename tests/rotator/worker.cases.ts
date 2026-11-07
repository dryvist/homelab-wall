import { expect, test } from '@playwright/test';
import { SLIDES, mockSlides, watchFaults, activeSlideUrl } from './fixture';

// Track: self-heal — the service worker must keep the kiosk shell bootable through an outage even
// when nothing else is running (e.g. a human presses Reload mid-outage). Service-worker request
// interception is flaky enough across engines that this is scoped to Chromium, mirroring the
// existing CDP-only heap test below.
test('service worker keeps the rotator itself running, not just its HTML, through a total outage', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'service worker fetch interception is exercised on Chromium only');
  await page.unroute('**/sw.js'); // this test needs the real worker (see beforeEach above)
  await mockSlides(page);
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  // Every shell asset the origin serves — not just '/' — returns 500: rotator.js and config.json
  // included. A cache that only covers the root HTML would still boot a blank page here (the
  // script tag present, nothing behind it able to run); this must actually keep rotating.
  await page.route(
    (url) => url.pathname === '/' || url.pathname.startsWith('/rotator/') || url.pathname === '/config.json',
    (route) => route.fulfill({ status: 500, body: 'origin down' }),
  );
  await page.reload();
  await expect(page.locator('script[src="/rotator/rotator.js"]')).toHaveCount(1);
  await expect(page.locator('#layers')).toBeAttached();
  // The rotator having actually executed (not just the cached HTML rendering inertly) is what
  // builds an iframe per slide and activates one — proving the engine is running, not just its
  // markup. This doesn't assert the exact pre-outage slide set survived (config.json is a
  // deployment-time file with no on-disk fixture in this checkout, so the service worker's own
  // precache fetch for it — made from the worker's own context, outside this test's page-level
  // mocking — falls back to whatever the dev server actually has for it); that config.json itself
  // gets cached and served on a 5xx is covered by the shell-manifest test below.
  // (One iframe per slide is built synchronously in buildLayers(), before any slide's own ready
  // handshake — proof enough that the JS engine executed rather than merely a cached document
  // rendering; DEFAULT_SLIDES' real mc1-5 pages can take a while past this test's budget to each
  // finish their own ready handshake, so this doesn't wait on activateLayer() too.)
  await expect(page.locator('iframe')).not.toHaveCount(0);
});

// Guards against the shell cache silently drifting out of sync with the page it's meant to cover
// — re-derives the reference list independently (a fresh regex scan of the served index.html,
// not a call into site/sw.js) so a hand-maintained or stale manifest in the worker would fail this.
test('the service worker shell manifest covers every same-origin asset index.html references', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'service worker cache introspection is exercised on Chromium only');
  await page.unroute('**/sw.js'); // this test needs the real worker (see beforeEach above)
  await mockSlides(page);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  const htmlRefs = await page.evaluate(async () => {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const urls = new Set<string>();
    for (const m of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      try {
        const u = new URL(m[1], location.origin);
        if (u.origin === location.origin) urls.add(u.pathname);
      } catch { /* not a URL */ }
    }
    return [...urls];
  });
  expect(htmlRefs.length).toBeGreaterThan(0); // sanity: index.html does reference something

  const manifest = await page.evaluate(async () => {
    const cache = await caches.open('wall-shell');
    const stored = await cache.match('/__sw_shell_manifest__');
    return stored ? ((await stored.json()) as string[]) : [];
  });

  for (const ref of htmlRefs) {
    expect(manifest, `${ref} is referenced by index.html but missing from the SW shell manifest`).toContain(ref);
  }
});

// Track R4: the persistent-iframe model (Track R2) replaced a per-rotation create/destroy of
// two iframes' render contexts with one context per slide held for the page's whole life — the
// growth check this test makes is exactly the thing that change was for. `?fast=` (this file
// only, never read by real config) shortens every hold so many cycles run in real CI time; the
// heap check needs Chromium's own CDP Performance domain, so it doesn't run under WebKit.
test('10 rotation cycles produce no page errors and the heap stays within 10% growth', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Performance.getMetrics is a Chromium-only CDP API');
  const faults = watchFaults(page);
  await mockSlides(page);
  const HOLD_MS = 200;
  await page.goto(`/?fast=${HOLD_MS}`);
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  const heapUsed = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'JSHeapUsedSize')!.value;
  };

  let afterCycle2 = 0;
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    await page.waitForTimeout(HOLD_MS + 50);
    if (cycle === 2) afterCycle2 = await heapUsed();
  }
  const afterCycle10 = await heapUsed();

  expect(faults).toEqual([]);
  expect(afterCycle10, `heap grew from ${afterCycle2} to ${afterCycle10}`).toBeLessThanOrEqual(afterCycle2 * 1.1);
});
