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
      await page.route(`**${s.url}`, (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${s.name}</title>` }));
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

test('only two iframes exist and both stay non-blank', async ({ page }) => {
  await mockSlides(page);
  await page.goto('/');
  await expect(page.locator('iframe')).toHaveCount(2);
  await expect.poll(async () => {
    const srcs = await page.locator('iframe').evaluateAll((els) => els.map((el) => (el as HTMLIFrameElement).src));
    return srcs.every((s) => s && !s.endsWith('about:blank'));
  }).toBe(true);
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
