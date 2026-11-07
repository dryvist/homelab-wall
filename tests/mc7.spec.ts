import { expect, test } from '@playwright/test';
import { mockMc7 } from './mc7-fixture';
import { Q } from '../site/lib/queries.js';

test.beforeEach(() => test.skip(!!process.env.WALL_URL, 'offline fixture contract'));

for (const snapshot of [false, true]) {
  test(`MC7 displays real engine and router query results (${snapshot ? 'snapshot' : 'gateway'})`, async ({ page }) => {
    const faults: string[] = [], ranges: URL[] = [];
    page.on('pageerror', (e) => faults.push(e.message));
    page.on('request', (r) => { if (r.url().includes('/query_range?')) ranges.push(new URL(r.url())); });
    await mockMc7(page, { snapshot });
    await page.goto('/mc7/');
    await expect(page).toHaveTitle('MC7 · AI Benchmark Cockpit');
    const engine = page.locator('.card[data-backend="vllm"]');
    for (const [key, expected] of Object.entries({
      engineDecode: '120.0', enginePrefill: '800.0', engineTtftP50: '100ms', engineTtftP95: '250ms', engineTtftP99: '500ms',
      engineItlP50: '10ms', engineItlP99: '50ms', engineE2eP95: '2.5s', engineRunning: '3', engineWaiting: '2',
      engineKvPercent: '65.0%', enginePrefixPercent: '40.0%', engineSpecPercent: '75.0%', acceleratorWatts: '240.0 W', acceleratorTokensPerJoule: '0.500',
    })) await expect(engine.locator(`[data-metric="${key}"]`)).toHaveText(expected);
    for (const canvas of await engine.locator('canvas').all()) await expect(canvas).toHaveAttribute('data-samples', '41');
    const router = page.locator('.card[data-backend="router"][data-model="model-large"]');
    for (const [key, value] of Object.entries({ routerTtftP50: '200ms', routerTtftP95: '800ms', routerE2eP95: '4.0s' })) {
      await expect(router.locator(`[data-metric="${key}"]`)).toHaveText(value);
    }
    const llama = page.locator('.card[data-backend="llamacpp"]');
    await expect(llama.locator('h3')).toHaveText('engine-embed · llama.cpp');
    await expect(llama.locator('[data-metric="engineDecode"]')).toHaveText('25.0');
    await expect(llama.locator('[data-metric="engineTtftP50"]')).toHaveText('NO DATA');
    await expect(llama).toContainText('accelerator association unavailable');
    if (!snapshot) for (const expr of [Q.engineDecode, Q.enginePrefill]) {
      const request = ranges.find((r) => r.searchParams.get('query') === expr);
      expect(request).toBeDefined();
      expect(request!.searchParams.get('step')).toBe('15');
      expect(Number(request!.searchParams.get('end')) - Number(request!.searchParams.get('start'))).toBe(600);
    }
    expect(faults).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const mode of ['empty', 'error'] as const) {
  test(`MC7 ${mode} telemetry never creates models or history`, async ({ page }) => {
    await mockMc7(page, { [mode]: true });
    await page.goto('/mc7/');
    for (const id of ['engines', 'routers']) {
      await expect(page.locator(`#${id}`)).toHaveText('NO DATA');
      await expect(page.locator(`#${id}`)).toHaveAttribute('data-state', mode);
    }
    await expect(page.locator('canvas, .card, [data-source="stand-in"]')).toHaveCount(0);
  });
}

test('MC7 keeps held values through a failed poll, marks them STALE once the source sample is five minutes old, then clears nonfinite values', async ({ page }) => {
  await mockMc7(page);
  let state = 'ok';
  await page.route('**/api/prom/**', (r) => {
    const expr = new URL(r.request().url()).searchParams.get('query');
    if ((state === 'failed' || state === 'aged') && expr === Q.engineDecode) return r.fulfill({ status: 500 });
    if (state === 'gap' && [Q.engineDecode, Q.engineKvPercent].includes(expr!)) {
      return r.fulfill({ json: { status: 'success', data: { result: [{ metric: { backend: 'vllm', model: 'engine-large' }, value: [1, 'NaN'] }] } } });
    }
    return r.fallback();
  });
  // A held reading keeps its last measured time, so it ages only as the page clock moves on.
  await page.clock.install();
  await page.goto('/mc7/');
  const decode = page.locator('.card[data-backend="vllm"] [data-metric="engineDecode"]');
  await expect(decode).toHaveText('120.0');
  state = 'failed';
  await expect(page.locator('#status')).toContainText('Telemetry incomplete');
  await expect(decode).toHaveText('120.0');
  await expect(page.locator('canvas').first()).toHaveAttribute('data-samples', '41');
  await expect(page.locator('canvas').first()).toHaveAttribute('data-state', 'stale');
  state = 'aged';
  await page.clock.fastForward('05:01');
  await expect(decode).toHaveText(/^120\.0 · STALE 5m \d+s$/);
  state = 'gap';
  await expect(decode).toHaveText('NO DATA');
  await expect(page.locator('body')).not.toContainText(/NaN|Infinity|undefined/);
});

test('MC7 signals ready before a pending telemetry request finishes', async ({ page }) => {
  await mockMc7(page);
  await page.addInitScript(() => {
    addEventListener('message', (event) => { if (event.data?.wall === 'ready') document.body.dataset.ready = 'yes'; });
  });
  await page.route('**/api/prom/**', () => {});
  await page.goto('/mc7/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
});
