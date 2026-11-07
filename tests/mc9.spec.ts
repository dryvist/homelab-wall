import { test, expect } from '@playwright/test';
import { mockMC9 } from './mc9.fixture';

test('constellation shows real rates, idle nodes, satellites, and pending sources', async ({ page }, testInfo) => {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await mockMC9(page);
  await page.goto('/mc9/');
  await expect(page.locator('#constellation')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('.node')).toHaveCount(9);
  await expect(page.locator('[data-node="codex"]')).toHaveAttribute('data-state', 'active');
  await expect(page.locator('[data-node="codex"] .rate')).toHaveText('12 output tokens/s');
  await expect(page.locator('[data-node="codex-subagents"] .rate')).toHaveText('4 output tokens/s');
  await expect(page.locator('[data-node="memory"]')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('[data-node="spans"] .rate')).toHaveText('Pending · no activity data');
  await expect(page.locator('[data-node="gateway"] .rate')).toHaveText('2 active agents');
  await expect(page.locator('[data-node="cron"]')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#status')).toHaveText('8 signals reporting · 1 pending');
  await expect(page.locator('body')).not.toContainText(/session_id|user_id|agent_name|session_source/);
  await expect.poll(() => page.locator('#sky').evaluate((el) => (el as HTMLCanvasElement).toDataURL().length)).toBeGreaterThan(2000);
  await page.screenshot({ path: testInfo.outputPath('mc9.png') });
  expect(faults).toEqual([]);
});

test('empty and failed initial feeds never fabricate a rate', async ({ page }) => {
  await mockMC9(page, { empty: true });
  await page.goto('/mc9/');
  await expect(page.locator('.node[data-state="pending"]')).toHaveCount(9);
  await expect(page.locator('.rate')).toHaveText(Array(9).fill('Pending · no activity data'));
  await mockMC9(page, { fail: true });
  await page.reload();
  await expect(page.locator('#status')).toHaveText('0 signals reporting · 9 pending');
  await expect(page.locator('.node[data-state="pending"]')).toHaveCount(9);
});

test('failed polls retain the last measured rate and label it stale', async ({ page }) => {
  await mockMC9(page, { refreshSeconds: 1 });
  await page.goto('/mc9/');
  await expect(page.locator('#constellation')).toHaveAttribute('data-state', 'ok');
  await page.route('**/api/prom/**', (route) => route.fulfill({ status: 500, body: 'fixture failure' }));
  await expect(page.locator('[data-node="codex"]')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('[data-node="codex"] .rate')).toHaveText('STALE · 12 output tokens/s');
  await expect(page.locator('[data-node="codex"] .age')).toContainText('STALE');
  await expect(page.locator('#constellation')).toHaveAttribute('data-state', 'stale');
});

test('history failure is separate from fresh instantaneous activity', async ({ page }) => {
  await mockMC9(page, { failHistory: true });
  await page.goto('/mc9/');
  await expect(page.locator('[data-node="codex"]')).toHaveAttribute('data-state', 'active');
  await expect(page.locator('[data-node="codex"] .history')).toHaveText('History stale');
});

test('reduced motion and pause controls work without viewport overflow', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockMC9(page);
  await page.goto('/mc9/');
  await expect(page.getByRole('button', { name: 'Resume motion' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Resume motion' }).click();
  await expect(page.getByRole('button', { name: 'Pause motion' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

test('default rotation places MC9 after MC6, MC7 and MC8', async ({ page }) => {
  await mockMC9(page, { empty: true });
  await page.route('**/sw.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('iframe')).toHaveCount(9);
  const paths = await page.locator('iframe').evaluateAll((frames) => frames.map((f) => new URL((f as HTMLIFrameElement).src).pathname));
  expect(paths.slice(-4)).toEqual(['/mc6/', '/mc7/', '/mc8/', '/mc9/']);
});
