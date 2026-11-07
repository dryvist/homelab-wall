import { expect, test } from '@playwright/test';
import { SLIDES, mockSlides, watchFaults, activeSlideUrl } from './fixture';

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

// The MC6 slide posts 'ready' after its first painted frame (site/lib/stage.js loop/signalReady),
// and that frame does not wait on its font probes or its words feed. The font files are held
// pending for the whole test. Each font probe has a 3s deadline, so the first refresh still runs
// and the words render while the fonts stay pending; the rotator must show the slide throughout
// and never mark it skipped.
test('mc6 posts ready on its first frame while its font files are held pending', async ({ page }) => {
  // Context-level routes: the LEXICON iframe's first requests race a page-level route, so its
  // config.json has been seen to reach the server unrouted (404) and stop the slide before its probes.
  let fontsHeld = 0;
  const context = page.context();
  await context.route('**/config.json', (r) => r.fulfill({
    json: { slides: [{ name: 'Slide A', url: '/slide-a', seconds: 2 }, { name: 'LEXICON', url: '/mc6/', seconds: 10 }], holdSeconds: 30 },
  }));
  await context.route('**/slide-a', (r) => r.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>Slide A</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
  }));
  await context.route('**/api/words', (r) => r.fulfill({ json: { meta: [], data: [{ source: 'user', word: 'deadline', n: '5' }], rows: 1 } }));
  await context.route('**/fonts/**', () => { fontsHeld += 1; });
  await page.goto('/');
  await expect.poll(() => activeSlideUrl(page), { timeout: 15_000, message: 'LEXICON never became the active slide' }).toContain('/mc6/');
  expect(await page.locator('#dots').getAttribute('data-skipped'), 'skip marker').toBeNull();
  expect(fontsHeld, 'font requests held pending').toBeGreaterThan(0);
  // The words render after the font deadline, with every font request still pending.
  const drawnWords = async () => {
    const frame = page.frames().find((f) => f.url().endsWith('/mc6/'));
    if (!frame) return [];
    return frame.evaluate(() => (window as unknown as { __mc6?: { drawn(): { words: { text: string }[] } | null } }).__mc6?.drawn()?.words.map((w) => w.text) ?? []);
  };
  await expect.poll(drawnWords, { timeout: 15_000, message: 'words never rendered while the fonts stayed pending' }).toContain('deadline');
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
