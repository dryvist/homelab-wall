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
