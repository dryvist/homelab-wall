import { expect, test } from '@playwright/test';
import { mockFeeds, config } from './fixture';
import { Q } from '../site/lib/queries.js';

test.beforeEach(() => test.skip(!!process.env.WALL_URL, 'offline fixture contract'));

test('MC3 shows engine rates, vLLM percentiles, ratios, and device efficiency', async ({ page }) => {
  const ranges: URL[] = [];
  page.on('request', (r) => { if (r.url().includes('/query_range?')) ranges.push(new URL(r.url())); });
  await mockFeeds(page);
  await page.goto('/mc3/?gl=2d');
  const engine = page.locator('.mc[data-backend="vllm"]');
  await expect(engine.locator('.mctok')).toHaveText('120.0decode tok/s');
  for (const [key, expected] of Object.entries({
    prefill: '800.0', 'ttft-p50': '100ms', 'ttft-p95': '250ms', 'ttft-p99': '500ms',
    'itl-p50': '10ms', 'itl-p99': '50ms', concurrency: '3 / 2', kv: '65.0%',
    prefix: '40.0%', spec: '75.0%', watts: '240.0 W', efficiency: '0.500',
  })) await expect(engine.locator(`[data-metric="${key}"]`)).toHaveText(expected);
  await expect(engine.locator('canvas')).toHaveCount(2);
  for (const canvas of await engine.locator('canvas').all()) await expect(canvas).toHaveAttribute('data-samples', '41');
  for (const expr of [Q.engineDecode, Q.enginePrefill, Q.llmTokRate, Q.routerInput]) {
    const request = ranges.find((r) => r.searchParams.get('query') === expr);
    expect(request, expr).toBeDefined();
    expect(request!.searchParams.get('step')).toBe('15');
    expect(Number(request!.searchParams.get('end')) - Number(request!.searchParams.get('start'))).toBe(600);
  }
  const llama = page.locator('.mc[data-backend="llamacpp"]');
  await expect(llama.locator('.mctok')).toHaveText('25.0decode tok/s');
  await expect(llama.locator('[data-metric="concurrency"]')).toHaveText('1 / 0');
  await expect(llama.locator('[data-metric="spec"]')).toHaveText('60.0%');
  for (const key of ['ttft-p50', 'itl-p99', 'kv', 'prefix', 'watts', 'efficiency']) {
    await expect(llama.locator(`[data-metric="${key}"]`)).toHaveText('NO DATA');
  }
});

test('MC3 router timings stay unavailable pending ingest repair', async ({ page }) => {
  await mockFeeds(page);
  await page.goto('/mc3/?gl=2d');
  const router = page.locator('.mc[data-backend="router"][data-model="model-large"]');
  await expect(router.locator('[data-metric="ttft-avg"]')).toHaveText('NO DATA · router averages pending ingest fix');
  await expect(router.locator('[data-metric="itl-avg"]')).toHaveText('NO DATA · router averages pending ingest fix');
  await expect(router).toContainText('Router input tok/s');
  await expect(router).toContainText('router output');
  await expect(router).not.toContainText(/p50|p95|p99/);
  await expect(router.locator('[data-metric="kv"]')).toHaveText('NO DATA');
  await expect(router.locator('.mcstats')).toHaveText('queue avg / API avg NO DATA · router averages pending ingest fix');
});

for (const mode of ['empty', 'error'] as const) {
  test(`MC3 ${mode} telemetry never creates sample models, KPI zeroes, or history`, async ({ page }) => {
    await mockFeeds(page, mode === 'empty' ? { emptyQuery: () => true } : { failQuery: () => true });
    await page.goto('/mc3/?gl=2d');
    await expect(page.locator('#modeltab')).toHaveText('NO ENGINE OR ROUTER DATA');
    await expect(page.locator('#kpis .kpi b')).toHaveText(['NO DATA', 'NO DATA', 'NO DATA', 'NO DATA']);
    await expect(page.locator('#modeltab canvas')).toHaveCount(0);
    await expect(page.locator('[data-source="stand-in"]')).toHaveCount(0);
    await expect(page.locator('#reactor')).toHaveAttribute('data-streams', '0');
  });
}

test('MC3 range failures and nonfinite values stay explicit and clear on later polls', async ({ page }) => {
  await mockFeeds(page);
  await page.route('**/config.json', (r) => r.fulfill({ json: { ...config, refreshSeconds: 1 } }));
  let missing = false;
  await page.route('**/api/prom/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('query_range')) return r.fulfill({ status: 500, json: { status: 'error' } });
    if (missing && [Q.engineDecode, Q.engineKvPercent].includes(url.searchParams.get('query')!)) {
      return r.fulfill({ json: { status: 'success', data: { result: [{ metric: { backend: 'vllm', model: 'engine-large' }, value: [1, 'NaN'] }] } } });
    }
    return r.fallback();
  });
  await page.goto('/mc3/?gl=2d');
  const engine = page.locator('.mc[data-backend="vllm"]');
  await expect(engine.locator('.mctok')).toHaveText('120.0decode tok/s');
  await expect(engine.locator('.mcspark').first()).toHaveAttribute('data-samples', '0');
  missing = true;
  await expect(engine.locator('.mctok')).toContainText('NO DATA');
  await expect(engine.locator('[data-metric="kv"]')).toHaveText('NO DATA');
  await expect(page.locator('#modeltab')).not.toContainText(/NaN|Infinity|undefined/);
});
