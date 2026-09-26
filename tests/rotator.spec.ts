import { expect, test } from '@playwright/test';

// Self-contained fixture — deliberately does not import tests/fixture.ts, which belongs to the
// mc1/panel-contract suite and is being edited concurrently by another lane.
const SLIDES = [
  { name: 'Slide A', url: '/slide-a', seconds: 10 },
  { name: 'Slide B', url: '/slide-b', seconds: 10 },
  { name: 'Slide C', url: '/slide-c', seconds: 10 },
];

async function mockSlides(page: import('@playwright/test').Page, holdSeconds = 30, brokenIndex = -1) {
  await page.route('**/config.json', (r) => r.fulfill({ json: { slides: SLIDES, holdSeconds } }));
  for (const [i, s] of SLIDES.entries()) {
    if (i === brokenIndex) {
      await page.route(`**${s.url}`, (r) => r.fulfill({ status: 404, body: 'not found' }));
    } else {
      // The rotator's ready handshake (site/rotator/rotator.js, Track G3): a same-origin slide
      // is only counted healthy once it posts {wall:'ready'} to its parent, the same message
      // site/lib/stage.js sends once a real MC page's first frame has painted. This fixture
      // stands in for that.
      await page.route(`**${s.url}`, (r) => r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>${s.name}</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
      }));
    }
  }
}

// `ignore` excludes the browser's own network-status logging (e.g. "Failed to load resource:
// ... 404") for a deliberately-broken URL under test — that's the browser reporting the fetch
// probe's result, not an application bug.
function watchFaults(page: import('@playwright/test').Page, ignore?: RegExp) {
  const faults: string[] = [];
  const record = (text: string) => { if (!ignore || !ignore.test(text)) faults.push(text); };
  page.on('pageerror', (e) => record(e.message));
  page.on('console', (m) => { if (m.type() === 'error') record(m.text()); });
  return faults;
}

async function activeSlideUrl(page: import('@playwright/test').Page) {
  return page.locator('.layer.active').getAttribute('src');
}

test('rotation advances across slides on the fake clock', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page);
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  await page.clock.fastForward(10_000);
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-b');

  await page.clock.fastForward(10_000);
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-c');

  await page.clock.fastForward(10_000);
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
});

test('hold pins for holdSeconds and restarts on each input', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page, 30);
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  // Wait for the dot bar's "visible" side-effect of pin() before advancing the fake clock —
  // page.mouse.move()'s promise resolves once the input is dispatched, not once the page's
  // mousemove handler has finished running, so racing straight into fastForward is flaky.
  await page.mouse.move(50, 50);
  await expect(page.locator('#dots')).toHaveClass(/visible/);
  await page.clock.fastForward(15_000);
  await expect(page.locator('.layer.active')).toHaveAttribute('src', /slide-a/);

  await page.mouse.move(60, 60); // restarts the 30s hold
  await expect(page.locator('#dots')).toHaveClass(/visible/);
  await page.clock.fastForward(20_000); // 20s since restart, still under 30s
  await expect(page.locator('.layer.active')).toHaveAttribute('src', /slide-a/);

  await page.clock.fastForward(15_000); // hold lapses (35s since restart)
  await page.clock.fastForward(10_000); // rotation resumes after one slide interval
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-b');
});

test('P toggles an indefinite pause', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page);
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  await page.keyboard.press('p');
  await page.clock.fastForward(120_000);
  await expect(page.locator('.layer.active')).toHaveAttribute('src', /slide-a/);

  await page.keyboard.press('p');
  await page.clock.fastForward(10_000);
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-b');
});

test('one persistent iframe exists per slide and all stay non-blank', async ({ page }) => {
  await mockSlides(page);
  await page.goto('/');
  await expect(page.locator('iframe')).toHaveCount(SLIDES.length);
  const srcs = await page.locator('iframe').evaluateAll((els) => els.map((el) => (el as HTMLIFrameElement).src));
  expect(srcs.every((s) => s && !s.endsWith('about:blank'))).toBe(true);
});

test('a broken slide is skipped, never shown, with no application errors', async ({ page }) => {
  // The browser's own "Failed to load resource: 404" logging for the deliberately-broken URL is
  // expected here (that's the reachability probe doing its job) and is excluded — this still
  // catches any real application-level error (an uncaught exception, an unrelated console.error).
  const faults = watchFaults(page, /Failed to load resource/);
  await page.clock.install();
  await mockSlides(page, 30, 1); // slide-b (index 1) 404s
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  await page.clock.fastForward(10_000); // would advance to slide-b, but it 404s
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-c');
  await expect(page.locator('#skip')).toContainText('Slide B');

  expect(faults).toEqual([]);
});

// Track: a layer whose readyPromise settled false must not be skipped forever — every
// REPROBE_MS (rotator.js) it reloads and re-arms. `?reprobe=<ms>` is a test-only override
// (mirrors the existing `?fast=` pattern), never read by real config.
test('a broken slide is re-probed and rejoins rotation once it recovers', async ({ page }) => {
  await page.clock.install();
  let brokenRequests = 0;
  await page.route('**/config.json', (r) => r.fulfill({ json: { slides: SLIDES, holdSeconds: 30 } }));
  await page.route('**/slide-a*', (r) => r.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>Slide A</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
  }));
  await page.route('**/slide-c*', (r) => r.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>Slide C</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
  }));
  // slide-b: 404 the first time (broken at boot), then answer ready on every later request (as if
  // it recovered) — brokenRequests counts how many times its iframe actually re-navigated to it.
  await page.route('**/slide-b*', (r) => {
    brokenRequests += 1;
    if (brokenRequests === 1) return r.fulfill({ status: 404, body: 'not found' });
    return r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Slide B</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
    });
  });

  await page.goto('/?reprobe=1000'); // 1s re-probe interval instead of the real 5 minutes
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  expect(brokenRequests).toBe(1); // broken once at boot, not reprobed yet

  // slide-b's own PROBE_TIMEOUT_MS (5s) must lapse — settling it ok:false — before a re-probe
  // tick has anything to act on; 6s covers that plus at least one 1s re-probe tick after.
  await page.clock.fastForward(6_000);
  await expect.poll(() => brokenRequests).toBeGreaterThan(1); // rotator.js reloaded it

  // Cycle around to slide-b (skipped once already at boot) and confirm it now shows, not skips.
  await page.clock.fastForward(10_000); // slide-a -> slide-b
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-b');
});

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

// Track: self-heal — a reload must never navigate into a dead origin. The preflight fetch in
// scheduleReload() targets the exact page URL, so intercepting only fetch-type requests to '/'
// (never the 'document' request of the initial page.goto) lets the origin "go down" without
// breaking the mocked navigation that already happened.
test('reload preflight blocks navigation on a 500 and proceeds once the origin recovers', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page);
  // This test is about the preflight fetch in rotator.js, not the service worker (covered
  // separately below) — registering one anyway means its install-time fetch (site/sw.js hashing
  // rotator.js) runs concurrently in the background and races the preflight's own fetch to '/',
  // which is flaky specifically under WebKit. Blocking /sw.js keeps the registration a no-op
  // (register() rejects, caught and ignored by rotator.js) so no such background work ever starts.
  await page.route('**/sw.js', (route) => route.abort());
  let preflightRequests = 0;
  let healthy = false;
  await page.route((url) => url.pathname === '/', (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    preflightRequests += 1;
    if (!healthy) return route.fulfill({ status: 500, body: 'origin down' });
    return route.continue();
  });

  await page.goto('/?reloadms=10000');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.evaluate(() => { (window as any).__marker = 'alive'; });

  await page.clock.fastForward(10_000); // reload timer fires; preflight gets a 500
  await expect.poll(() => preflightRequests).toBeGreaterThan(0);
  expect(await markerGone(page)).toBe(false); // did not navigate away

  healthy = true;
  await page.clock.fastForward(60_000); // RELOAD_RETRY_MS
  await expect.poll(() => markerGone(page)).toBe(true); // now reloads
});

// Track: self-heal — the service worker must keep the kiosk shell bootable through an outage even
// when nothing else is running (e.g. a human presses Reload mid-outage). Service-worker request
// interception is flaky enough across engines that this is scoped to Chromium, mirroring the
// existing CDP-only heap test below.
test('service worker serves the cached shell when the origin returns 500 on navigation', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'service worker fetch interception is exercised on Chromium only');
  await mockSlides(page);
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  await page.route((url) => url.pathname === '/', (route) => route.fulfill({ status: 500, body: 'origin down' }));
  await page.reload();
  await expect(page.locator('script[src="/rotator/rotator.js"]')).toHaveCount(1);
  await expect(page.locator('#layers')).toBeAttached();
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
