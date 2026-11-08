import { expect, test, type Locator } from '@playwright/test';
import { Q } from '../site/lib/queries.js';
import { config, mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';

// Counts opaque pixels in an LLM row canvas: the dashed no-history baseline (#1d3a4f) and the live trace (#ff4fd8).
const pixels = (canvas: Locator) => canvas.evaluate((element: HTMLCanvasElement) => {
  const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
  let baseline = 0, trace = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    if (Math.abs(r - 0x1d) < 16 && Math.abs(g - 0x3a) < 16 && Math.abs(b - 0x4f) < 16) baseline += 1;
    if (r > 200 && g < 140 && b > 150) trace += 1;
  }
  return { baseline, trace };
});

test('mc1 LLM rows keep a dashed baseline until a model has two token-rate samples', async ({ page }) => {
  test.skip(!!wallUrl, 'holds fixture-shaped router responses');
  await mockFeeds(page);
  await page.route('**/config.json', (route) => route.fulfill({ json: { ...config, refreshSeconds: 1 } }));
  // model-mini never reports a token rate, so its history never reaches two samples.
  await page.route('**/api/prom/query?**', (route) => {
    if (new URL(route.request().url()).searchParams.get('query') !== Q.routerOutput) return route.fallback();
    const at = Date.now() / 1000;
    return route.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: [
      { metric: { model: 'model-large' }, value: [at, '38'] },
      { metric: { model: 'model-coder' }, value: [at, '91'] },
    ] } } });
  });
  await page.goto('/mc1/?gl=2d');
  const row = (name: string) => page.locator('#llmrows .lr').filter({ has: page.locator(`span[title="${name}"]`) }).locator('canvas');

  await expect.poll(async () => (await pixels(row('model-coder'))).trace).toBeGreaterThan(20);
  const empty = await pixels(row('model-mini'));
  expect(empty.trace).toBe(0);
  expect(empty.baseline).toBeGreaterThan(20);
});
