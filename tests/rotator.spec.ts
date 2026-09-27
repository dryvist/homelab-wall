import { expect, test } from '@playwright/test';

// Self-contained fixture — deliberately does not import tests/fixture.ts, which belongs to the
// mc1/panel-contract suite and is being edited concurrently by another lane.
const SLIDES = [
  { name: 'Slide A', url: '/slide-a', seconds: 10 },
  { name: 'Slide B', url: '/slide-b', seconds: 10 },
  { name: 'Slide C', url: '/slide-c', seconds: 10 },
];

// rotator.js registers a real service worker unconditionally (site/sw.js). Almost none of these
// tests are about that worker, and letting it register anyway means its background install-time
// fetches (hashing rotator.js, precaching the shell) compete with the single-threaded dev server
// used across the whole file, which has produced flaky timing elsewhere in this suite. Blocking
// /sw.js by default removes that noise; the two tests that actually cover the service worker call
// page.unroute('**/sw.js') first to let it register for real.
test.beforeEach(async ({ page }) => {
  await page.route('**/sw.js', (route) => route.abort());
});

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
  // Machine-readable only — the wall shows no visible non-production text (operator aesthetics
  // rule), so the skip signal is a data attribute on the dots container, never rendered copy.
  await expect(page.locator('#dots')).toHaveAttribute('data-skipped', 'Slide B');
  await expect(page.locator('#dots')).not.toContainText('Slide B');

  expect(faults).toEqual([]);
});

// Track: heavy WebGL slides can post {wall:'ready'} after PROBE_TIMEOUT_MS lapses, settling the
// layer false first. armLayer()'s finish must let that late success rejoin rotation immediately
// rather than waiting out the 5-minute reprobeBroken() cycle. slide-b's fixture never posts ready
// on its own (standing in for a render loop that hasn't painted a first frame yet); once the probe
// window lapses and it's been skipped, the test posts the message itself directly into the
// iframe's own frame — the same 'ready' handshake a slow real slide sends, just triggered by hand
// instead of raced against the fake clock, which otherwise fights CDP's virtual-time network
// queueing in ways that have nothing to do with the behavior under test.
test('a slide whose ready arrives after the probe timeout rejoins rotation on the next cycle', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page, 30);
  await page.route('**/slide-b', (r) => r.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Slide B</title>', // no ready handshake — simulates a slow first frame
  }));
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  // slide-b's PROBE_TIMEOUT_MS (5s, fake) lapses with no 'ready' yet, so the first visit skips it.
  await page.clock.fastForward(10_000);
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-c');
  await expect(page.locator('#dots')).toHaveAttribute('data-skipped', 'Slide B');

  // slide-b's heavy render loop finally paints and posts its late 'ready'.
  const slideBFrame = page.frames().find((f) => f.url().includes('/slide-b'));
  await slideBFrame?.evaluate(() => parent.postMessage({ wall: 'ready' }, '*'));

  // The next cycle back around to slide-b must show it, not skip it again. Two separate
  // fastForward calls, not one fastForward(20_000) — a timer armed *during* a fastForward call
  // (here, the next rotateTimer, armed inside commit()) isn't guaranteed to fire within that same
  // call's remaining budget, matching the pattern the rest of this file already uses.
  await page.clock.fastForward(10_000); // slide-c -> slide-a
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');
  await page.clock.fastForward(10_000); // slide-a -> slide-b
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-b');
});

// A4: a page posts 'ready' on first paint (site/lib/stage.js signalReady/loop), never gated on
// its own data query resolving — so a slide whose underlying data fetch would take longer than
// its own rotation hold must still show in the very first cycle, never skipped as "slow".
test('a slide whose data takes longer than its own hold interval is still shown in cycle 1', async ({ page }) => {
  await page.clock.install();
  await mockSlides(page); // holdSeconds: 30, each SLIDES entry holds for its own 10s
  await page.route('**/slide-b', (r) => r.fulfill({
    contentType: 'text/html',
    // 'ready' fires immediately (first paint) exactly like every real MC page's loop()/
    // signalReady() — a setTimeout stands in for a data query that only resolves after 10s,
    // longer than this slide's own hold, and must never be awaited before 'ready' posts.
    body: '<!doctype html><title>Slide B</title><script>' +
      "parent.postMessage({wall:'ready'},'*');" +
      'setTimeout(() => {}, 10000);' +
      '</script>',
  }));
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-a');

  await page.clock.fastForward(10_000); // slide-a -> slide-b
  await expect.poll(() => activeSlideUrl(page)).toContain('/slide-b');
  await expect(page.locator('#dots')).not.toHaveAttribute('data-skipped', 'Slide B');
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
