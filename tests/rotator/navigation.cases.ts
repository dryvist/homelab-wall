import { expect, test } from '@playwright/test';
import { SLIDES, mockSlides, watchFaults, activeSlideUrl } from './fixture';

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

// The wall's ?gl= reaches same-origin wall slides (/mcN/) only; another same-origin path and a
// cross-origin slide keep their URLs as configured.
test('?gl=2d on the wall is passed to same-origin wall slides only', async ({ page }) => {
  const slides = [
    { name: 'Wall', url: '/mc3/', seconds: 10 },
    { name: 'Board', url: '/boards/wall?x=1', seconds: 10 },
    { name: 'Remote', url: 'https://remote.example.test/board', seconds: 10 },
  ];
  await page.route('**/config.json', (r) => r.fulfill({ json: { slides } }));
  await page.route('**/mc3/**', (r) => r.abort());
  await page.route('**/boards/**', (r) => r.abort());
  await page.route('https://remote.example.test/**', (r) => r.abort());
  await page.goto('/?gl=2d');
  await expect(page.locator('iframe')).toHaveCount(3);
  const srcs = await page.locator('iframe').evaluateAll((els) => els.map((el) => (el as HTMLIFrameElement).src));
  expect(new URL(srcs[0]).searchParams.get('gl')).toBe('2d');
  expect(new URL(srcs[1]).search).toBe('?x=1');
  expect(srcs[2]).toBe('https://remote.example.test/board');
});

// MC8 (SWITCHBOARD) joins DEFAULT_SLIDES after MC6 (LEXICON) and before MC9. With no `slides` in config.json the defaults
// apply: one persistent iframe per default slide, titled by slide name (buildLayers). The
// slide documents themselves are aborted — this asserts the rotator's own bookkeeping, not
// the pages' health (the panel suites cover that).
test('default slides include SWITCHBOARD after LEXICON', async ({ page }) => {
  await page.route('**/config.json', (r) => r.fulfill({ json: {} })); // no slides key -> DEFAULT_SLIDES
  for (const path of ['/mc1/', '/mc2/', '/mc3/', '/mc4/', '/mc5/', '/mc6/', '/mc8/', '/mc9/']) {
    await page.route(`**${path}`, (r) => r.abort());
  }
  await page.goto('/');
  const titles = await page.locator('iframe').evaluateAll((els) => els.map((el) => (el as HTMLIFrameElement).title));
  expect(titles).toEqual(['MC1', 'MC2', 'MC3', 'MC4', 'MC5', 'LEXICON', 'SWITCHBOARD', 'Agent Constellation']);
});

// The rotator keeps at most 10 layers. The deployed wall configures 8, so all of them get a
// layer; a configured eleventh slide is the first one left out.
test('up to 10 configured slides each get a layer, and an eleventh is left out', async ({ page }) => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `Slide ${i}`, url: `/slide-${i}`, seconds: 10 }));
  await page.route('**/config.json', (r) => r.fulfill({ json: { slides: many, holdSeconds: 30 } }));
  await page.route('**/slide-*', (r) => r.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>s</title><script>parent.postMessage({wall:\'ready\'},\'*\')</script>',
  }));
  await page.goto('/');
  await expect(page.locator('iframe')).toHaveCount(10);
  await expect(page.locator('iframe[src$="/slide-9"]')).toHaveCount(1);
  await expect(page.locator('iframe[src$="/slide-10"]')).toHaveCount(0);
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
