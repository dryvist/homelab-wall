import { expect, test } from '@playwright/test';
import { mockFeeds } from './fixture';
import rows from './ticker.fixture.json' with { type: 'json' };

const now = new Date('2026-11-06T12:00:30Z');
const ribbon = '#activity-ribbon';
const items = `${ribbon} .ticker-items:not([aria-hidden]) [role="listitem"]`;

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
});

test('MC1 ribbon renders only metadata, scrolls, and can pause', async ({ page }) => {
  await mockFeeds(page, { recent: rows.map((row) => ({
    ...row, content: 'DO_NOT_RENDER_CONTENT', prompt: 'DO_NOT_RENDER_PROMPT',
  })) });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator(ribbon)).toHaveAttribute('data-state', 'ok');
  await expect(page.locator(items)).toHaveCount(2);
  await expect(page.locator(items).first()).toHaveText('codexmodel-coderassistant2480 chars30s ago');
  await expect(page.locator(items).last()).toHaveText('usermodel-largeuser120 chars40s ago');
  await expect(page.locator(ribbon)).not.toContainText('DO_NOT_RENDER');
  await expect(page.locator(`${ribbon} .ticker-track`)).toHaveCSS('animation-name', 'ticker-scroll');
  await page.getByRole('button', { name: 'Pause activity ribbon' }).click();
  await expect(page.getByRole('button', { name: 'Resume activity ribbon' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`${ribbon} .ticker-track`)).toHaveCSS('animation-play-state', 'paused');
  await page.getByRole('button', { name: 'Resume activity ribbon' }).click();
  await expect(page.getByRole('button', { name: 'Pause activity ribbon' })).toBeFocused();
  expect(await page.getByRole('button', { name: 'Pause activity ribbon' }).evaluate((button) => button.matches(':hover'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Pause activity ribbon' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`${ribbon} .ticker-track`)).toHaveCSS('animation-play-state', 'running');
  const box = await page.locator(ribbon).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
});

test('polls every minute and shows event age without restamping old rows', async ({ page }) => {
  await mockFeeds(page, { recent: rows });
  let calls = 0;
  await page.route('**/api/llm/recent', (route) => {
    calls += 1;
    return route.fulfill({ json: { data: rows } });
  });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator(items)).toHaveCount(2);
  expect(calls).toBe(1);
  await page.clock.fastForward(59_000);
  expect(calls).toBe(1);
  await page.clock.fastForward(1000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(60_000);
  await expect(page.locator(ribbon)).toHaveAttribute('data-state', 'stale');
  await expect(page.locator(`${ribbon} .ticker-status`)).toHaveText('STALE 2m');
  await page.clock.fastForward(180_000);
  await expect(page.locator(`${ribbon} .ticker-status`)).toHaveText('STALE since 2026-11-06T12:00:00.000Z');
});

for (const scenario of ['empty', 'failed', 'invalid'] as const) {
  test(`${scenario} feed shows pending without invented entries`, async ({ page }) => {
    await mockFeeds(page, {
      recent: scenario === 'invalid' ? [{ ...rows[0], ts: 'bad', chars: -1 }] : [],
      failQuery: (q) => scenario === 'failed' && q === '/api/llm/recent',
    });
    await page.goto('/mc1/?gl=2d');
    await expect(page.locator(`${ribbon} .ticker-status`)).toHaveText('pending');
    await expect(page.locator(ribbon)).toHaveAttribute('data-state', 'pending');
    await expect(page.locator(items)).toHaveCount(0);
  });
}

test('failed refresh holds the last metadata as stale and recovers', async ({ page }) => {
  await mockFeeds(page, { recent: rows });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator(ribbon)).toHaveAttribute('data-state', 'ok');
  await page.route('**/api/llm/recent', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.clock.fastForward(60_000);
  await expect(page.locator(ribbon)).toHaveAttribute('data-state', 'stale');
  await expect(page.locator(items)).toHaveCount(2);
  await page.route('**/api/llm/recent', (route) => route.fulfill({ json: [
    { ...rows[0], ts: '2026-11-06T12:02:20Z', chars: 0 },
  ] }));
  await page.clock.fastForward(60_000);
  await expect(page.locator(ribbon)).toHaveAttribute('data-state', 'ok');
  await expect(page.locator(items)).toHaveCount(1);
  await expect(page.locator(items)).toContainText('0 chars');
});

test('reduced motion disables scrolling animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockFeeds(page, { recent: rows });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator(items)).toHaveCount(2);
  await expect(page.locator(`${ribbon} .ticker-track`)).toHaveCSS('animation-name', 'none');
});
