import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mockFeeds, recentRows } from './fixture';

// mc3-specific contract: the request feed is real metadata rows from GET /api/llm/recent (never
// message content, never fabricated rows), the GPU tile reads Q.acceleratorBusy, and the hero
// reactor proves itself on both render paths (?gl=2d and the default WebGPU/TSL one) with the
// same ready-message handshake the rotator (site/rotator/rotator.js) depends on.
const wallUrl = process.env.WALL_URL;

function watchFaults(page: Page) {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(message.text());
  });
  page.on('requestfailed', (request) => faults.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
  page.on('response', (response) => {
    if (response.status() >= 400) faults.push(`${response.status()} ${response.url()}`);
  });
  return faults;
}

for (const mode of ['2d', '3d'] as const) {
  test(`mc3 ${mode}: ready message, live feed rows, and no console errors`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    // Registered before any page script runs: signalReady fires after the very first rendered
    // frame, which can beat a listener installed after goto(). In the page's own window the
    // parent is the window itself, so the rotator's {wall:'ready'} post arrives with
    // e.source === window — exactly the handshake site/rotator/rotator.js listens for.
    await page.addInitScript(() => {
      (window as { wallReady?: number }).wallReady = 0;
      window.addEventListener('message', (e: MessageEvent) => {
        if (e.source === window && (e.data as { wall?: string })?.wall === 'ready') (window as { wallReady?: number }).wallReady! += 1;
      });
    });
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    // stage.js signalReady is once-guarded, so exactly one ready per load — the rotator contract.
    // Forced 3D on CI runs WebGPURenderer's WebGL2 backend on a software rasterizer, where the
    // first frame (shader builds plus the particle init dispatch) takes far longer than on the
    // wall's GPU. The 2D wait allows a cold first page load on a shared CI runner; the rotator
    // itself still accepts a late 'ready' (site/rotator/rotator.js).
    await expect.poll(() => page.evaluate(() => (window as { wallReady?: number }).wallReady), { timeout: mode === '3d' ? 45_000 : 15_000 }).toBe(1);

    await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'live');
    await expect(page.locator('#reqfeed .cfrow')).toHaveCount(recentRows.length);
    await expect(page.locator('#reqfeed')).toContainText('claude · model-coder');
    await expect(page.locator('#reqfeed')).toContainText('2.5k ch');
    await expect(page.locator('#reqfeed')).not.toContainText('tok');

    // The GPU tile shows the fixture's accelerator:busy_percent:avg5m mean (36/64 -> 50%), not a
    // stand-in derivation, and carries no stand-in marker.
    await expect(page.locator('#cxGpu')).toHaveText('50%');
    await expect(page.locator('#cxGpu')).not.toHaveAttribute('data-source', 'stand-in');

    expect(faults).toEqual([]);
  });
}

// The newest row arriving on a later poll must land in the feed and fire a comet from its core
// (the comet itself is GPU-side; this asserts the CPU handoff mc3.js owns: feedSeen diffing).
test('mc3: a new /api/llm/recent row prepends to the feed within one poll', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
  const faults = watchFaults(page);
  let served = 0;
  const later = [...recentRows, { ts: '2026-01-01 00:00:10', source: 'gemini', model: 'model-mini', role: 'user', chars: 64 }];
  await mockFeeds(page, { recent: () => (served++ === 0 ? recentRows : later) });
  await page.goto('/mc3/?gl=2d');
  await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'live');
  await expect(page.locator('#reqfeed')).toContainText('model-large');
  const first = () => page.locator('#reqfeed .cfrow').first().innerText();
  await expect.poll(first, { timeout: 10_000, message: 'the newest row never reached the feed' }).toContain('gemini');
  expect(faults).toEqual([]);
});

// No gateway route (the static fixture / a gateway without the ClickHouse feed): an explicit
// no-feed state, never fabricated rows, never a console error storm.
test('mc3: a missing /api/llm/recent renders an explicit NO FEED state with no invented rows', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the no-feed state against the fixture server only');
  const faults = watchFaults(page);
  await mockFeeds(page, { failQuery: (q) => q === '/api/llm/recent', emptyQuery: (q) => q.includes('accelerator:busy_percent') });
  await page.goto('/mc3/?gl=2d');
  await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'none');
  await expect(page.locator('#reqfeed')).toContainText('NO FEED');
  await expect(page.locator('#reqfeed .cfrow')).toHaveCount(1);
  // The GPU query succeeds with no series here: the tile is explicit, not 0%.
  await expect(page.locator('#cxGpu')).toHaveText('NO FEED');
  // The 404 itself is the feed being absent — pollFeed turns it into the state above; nothing
  // else may fault (no pageerror, no other request failure).
  // Chromium also logs the 404 as a generic console resource error.
  expect(faults.filter((f) => !(f.startsWith('404 ') && f.includes('/api/llm/recent')) && !f.includes('status of 404'))).toEqual([]);
});
