import { test, expect } from '@playwright/test';
import { highCardinalityRows, mockMc8, mc8Answer, tokenRows } from './mc8.fixture';
import { Q } from '../site/lib/queries.js';

test.beforeEach(() => { test.skip(!!process.env.WALL_URL, 'Fixture-only switchboard checks'); });

test('measured routes, provider banks and hero readings render without page faults', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockMc8(page);
  await page.goto('/mc8/');
  await expect(page.locator('[data-panel="routes"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#callers .terminal')).toHaveCount(2);
  await expect(page.locator('#models .terminal')).toHaveCount(3);
  await expect(page.locator('#local-rate')).toHaveText('90 t/s');
  await expect(page.locator('#in-flight')).toHaveText('local 3 · cloud 4');
  await expect(page.locator('#spend')).toHaveText(/123[.,]4¢/);
  await expect(page.locator('#ttft')).toHaveText('local 210 ms · cloud 420 ms');
  await expect(page.locator('#requests-value')).toHaveText('local 3 req/min · cloud 5 req/min');
  await expect(page.locator('#latency-value')).toContainText('p50  local 120 ms · cloud 240 ms');
  await expect(page.locator('#latency-value')).toContainText('p95  local 360 ms · cloud 480 ms');
  await expect(page.locator('#outcomes-value')).toContainText('Failures  local 1 · cloud 2');
  await expect(page.locator('#outcomes-value')).toContainText('Fallbacks  local 0 · cloud 1');
  await expect(page.locator('#top-models-value .top-model-group.local')).toContainText('local-model · 17 req');
  await expect(page.locator('#top-models-value .top-model-group.cloud')).toContainText('subscription-model · 12 req');
  await expect(page.locator('#route-state')).toHaveText('local 90 · cloud 40 tokens/s');
  await expect(page.locator('#callers .terminal').first().locator('.rate')).toHaveText('local 90 tokens/s · cloud 15 tokens/s');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  await page.screenshot({ path: test.info().outputPath('mc8.png'), fullPage: true });
});

test('high-cardinality routes fit one screen and keep collapsed terminal routes visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockMc8(page, { rows: highCardinalityRows });
  await page.goto('/mc8/');
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'ok');
  await page.evaluate(() => document.fonts.ready);

  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  await expect(page.locator('#callers .more')).toBeVisible();
  await expect(page.locator('#models .more')).toBeVisible();
  await expect(page.locator('#callers .more .rate')).toContainText('local');
  await expect(page.locator('#callers .more .rate')).toContainText('cloud');
  await expect(page.locator('#models .more .rate')).toContainText('local');
  await expect(page.locator('#models .more .rate')).toContainText('cloud');
  await expect(page.locator('#callers .terminal').first()).toContainText('caller-20');

  const callerMore = page.locator('#callers .more strong');
  const callerCount = Number((await callerMore.innerText()).match(/^\+(\d+) more$/)?.[1]);
  const visibleCallers = await page.locator('#callers .terminal:not(.more)').count();
  expect(Number.isInteger(callerCount)).toBe(true);
  expect(callerCount + visibleCallers).toBe(20);

  const modelMore = page.locator('#models .more strong');
  const [, localMore, cloudMore] = (await modelMore.innerText()).match(/^\+(\d+) local · \+(\d+) cloud$/) || [];
  const modelCount = Number(localMore) + Number(cloudMore);
  const visibleModels = await page.locator('#models .terminal:not(.more)').count();
  expect(Number.isInteger(modelCount)).toBe(true);
  expect(modelCount + visibleModels).toBe(12);

  const endpoints = await page.locator('#wires').evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect();
    const scale = canvas.width / bounds.width;
    const ctx = canvas.getContext('2d')!;
    const endpointPixels = (selector: string, side: 'left' | 'right') => {
      const target = document.querySelector(selector)!.getBoundingClientRect();
      const x = Math.round(((side === 'left' ? target.left : target.right) - bounds.left) * scale);
      const y = Math.round((target.top + target.height / 2 - bounds.top) * scale);
      const left = Math.max(0, x - 4), top = Math.max(0, y - 4);
      const width = Math.min(canvas.width - left, 9), height = Math.min(canvas.height - top, 9);
      const pixels = ctx.getImageData(left, top, width, height).data;
      let visible = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) visible++;
      return visible;
    };
    return {
      callers: endpointPixels('#callers .more', 'right'),
      models: endpointPixels('#models .more', 'left'),
    };
  });
  expect(endpoints.callers).toBeGreaterThan(0);
  expect(endpoints.models).toBeGreaterThan(0);

  const alpha = () => page.locator('#wires').evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0;
    for (let i = 3; i < pixels.length; i += 4) total += pixels[i];
    return total;
  });
  const beforeFocus = await alpha();
  await page.locator('#callers .more').focus();
  expect(await alpha()).not.toBe(beforeFocus);
});

test('a failure on a collapsed model shows on the "+N more" row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await mockMc8(page, { rows: highCardinalityRows, failure: true, fallback: true });
  await page.goto('/mc8/');
  await expect(page.locator('#models .more .failure-marker')).toHaveText('Failures · last minute · Failed fallback · last minute');
  expect(await page.locator('#models').evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
});

test('empty data remains pending and draws no sample routes or numeric heroes', async ({ page }) => {
  await mockMc8(page, { empty: true });
  await page.goto('/mc8/');
  await expect(page.locator('#flow-status')).toContainText('Pending');
  await expect(page.locator('.terminal')).toHaveCount(0);
  await expect(page.locator('.reading')).toHaveText(['Pending', '—', 'Pending', '—']);
});

test('pinned callers with no series stay in the caller list', async ({ page }) => {
  await mockMc8(page, { empty: true, pinnedCallers: ['queued-caller'] });
  await page.goto('/mc8/');
  const caller = page.locator('#callers .terminal').filter({ hasText: 'queued-caller' });
  await expect(caller).toBeVisible();
  await expect(caller.locator('.rate')).toHaveText('no requests yet');
});

test('cloud-only caller and route figures omit the absent local side', async ({ page }) => {
  const rows = tokenRows.filter((row) => row.labels.tag_telemetry_billing_class_local !== 'true');
  await mockMc8(page, { rows });
  await page.goto('/mc8/');
  await expect(page.locator('#route-state')).toHaveText('cloud 40 tokens/s');
  await expect(page.locator('#callers .terminal').first().locator('.rate')).toHaveText('cloud 25 tokens/s');
  await expect(page.locator('#callers .rate')).not.toContainText('local');
});

test('local-only caller and route figures omit the absent cloud side', async ({ page }) => {
  const rows = tokenRows.filter((row) => row.labels.tag_telemetry_billing_class_local === 'true');
  await mockMc8(page, { rows });
  await page.goto('/mc8/');
  await expect(page.locator('#route-state')).toHaveText('local 90 tokens/s');
  await expect(page.locator('#callers .terminal .rate')).toHaveText('local 90 tokens/s');
});

test('empty TTFT classes show missing values while their histogram sample times stay fresh', async ({ page }) => {
  await mockMc8(page, { idleTtft: true });
  await page.goto('/mc8/');
  await expect(page.locator('#ttft')).toHaveText('—');
  await expect(page.locator('[data-panel]:has(#ttft) .status')).toHaveText('Router histogram · trailing 5 minutes');
  await expect(page.locator('#in-flight')).toHaveText('local 3 · cloud 4');
});

test('a failed first poll stays pending', async ({ page }) => {
  await mockMc8(page, { fail: () => true });
  await page.goto('/mc8/');
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('.terminal')).toHaveCount(0);
});

test('a failed refresh retains measured routes and marks their age, then recovers', async ({ page }) => {
  let fail = false;
  await mockMc8(page, { fail: () => fail });
  await page.goto('/mc8/');
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'ok');
  fail = true;
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('#flow-status')).toContainText('STALE');
  await expect(page.locator('#models .terminal')).toHaveCount(3);
  await expect(page.locator('#in-flight')).toHaveText('local 3 · cloud 4');
  await expect(page.locator('[data-panel="in-flight"]')).toHaveAttribute('data-state', 'stale');
  fail = false;
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'ok');
});

test('snapshot mode resolves MC8 queries without reaching the live gateway', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/prom/')) calls.push(r.url()); });
  await mockMc8(page, { snapshot: true });
  await page.goto('/mc8/');
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#ttft')).toHaveText('local 210 ms · cloud 420 ms');
  expect(calls).toEqual([]);
});

test('old snapshot samples stay stale after repeated successful fetches and never mark failures', async ({ page }) => {
  await mockMc8(page, { snapshot: true });
  const instant = Object.fromEntries(Object.entries(Q).filter(([key]) => key.startsWith('mc8') || ['vllmRunning', 'llamaRunning'].includes(key)).map(([key, expr]) => {
    const result = mc8Answer(expr);
    for (const row of result) {
      row.value[0] = Date.now() / 1000 - 600;
      if (key.endsWith('SourceTime')) row.value[1] = String(Date.now() / 1000 - 600);
    }
    if (key === 'mc8Failures') result[0].value[1] = '1';
    return [key, { result }];
  }));
  await page.route('**/data/mc8.json', (r) => r.fulfill({ json: { generated_at: new Date().toISOString(), instant } }));
  await page.goto('/mc8/');
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('#failure-status')).toContainText('STALE');
  await expect(page.locator('.failure-marker.failure')).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(page.locator('#flow-status')).toContainText('STALE');
  await expect(page.locator('.failure-marker.failure')).toHaveCount(0);
});

test('unclassified share goes stale on its own when every token series is unclassified', async ({ page }) => {
  await mockMc8(page, { snapshot: true });
  const unclassified = Object.fromEntries(['local', 'subscription', 'paid', 'free'].map((bank) => [`tag_telemetry_billing_class_${bank}`, 'false']));
  const instant = Object.fromEntries(Object.entries(Q).filter(([key]) => key.startsWith('mc8') || ['vllmRunning', 'llamaRunning'].includes(key)).map(([key, expr]) => {
    const result = mc8Answer(expr);
    for (const row of result) {
      if (key.endsWith('Rate')) row.metric = { ...row.metric, ...unclassified };
      if (key.endsWith('SourceTime')) row.value[1] = String(Date.now() / 1000 - 301);
    }
    return [key, { result }];
  }));
  await page.route('**/data/mc8.json', (r) => r.fulfill({ json: { generated_at: new Date().toISOString(), instant } }));
  await page.goto('/mc8/');
  await expect(page.locator('#local-rate')).toHaveText('Unavailable');
  await expect(page.locator('#unclassified-share')).toContainText('unclassified cloud 100%');
  await expect(page.locator('#unclassified-share')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('#unclassified-share')).toContainText('STALE');
});

test('zero-token model failures remain visible without drawing token paths', async ({ page }) => {
  await mockMc8(page);
  await page.route('**/api/prom/query?**', (r) => {
    const expr = new URL(r.request().url()).searchParams.get('query') || '';
    const result = mc8Answer(expr);
    if (expr === Q.mc8InputRate || expr === Q.mc8OutputRate) {
      for (const row of result) row.value[1] = '0';
    }
    if (expr === Q.mc8Failures) result[0].value[1] = '1';
    return r.fulfill({ json: { status: 'success', data: { result } } });
  });
  await page.goto('/mc8/');
  await expect(page.locator('#route-state')).toHaveText('local 0 · cloud 0 tokens/s');
  const model = page.locator('#models .terminal').filter({ hasText: 'local-model' });
  await expect(model.locator('.rate')).toHaveText('0 t/s');
  await expect(model.locator('.failure-marker')).toHaveText('Failures · last minute');
});

test('canvas paints token paths and honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockMc8(page);
  await page.goto('/mc8/');
  await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'ok');
  await page.evaluate(() => document.fonts.ready);
  const pixels = () => page.locator('#wires').evaluate((node) => {
    const c = node as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data).reduce((s, n) => s + n, 0);
  });
  const before = await pixels();
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(100);
  expect(await pixels()).toBe(before);
});

for (const kind of ['failure', 'fallback'] as const) {
  test(`${kind} increases color only the model side of the paths`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockMc8(page, { [kind]: true });
    await page.goto('/mc8/');
    await expect(page.locator('#switchboard')).toHaveAttribute('data-state', 'ok');
    await page.evaluate(() => document.fonts.ready);
    const colors = await page.locator('#wires').evaluate((node, kind) => {
      const c = node as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const target = kind === 'failure' ? [255, 114, 136] : [255, 182, 107];
      const dpr = c.width / c.getBoundingClientRect().width;
      const hub = document.getElementById('hub')!.getBoundingClientRect();
      const left = (hub.left - c.getBoundingClientRect().left) * dpr;
      const right = left + hub.width * dpr;
      let caller = 0, model = 0;
      for (let p = 0; p < data.length; p += 4) {
        if (!data[p + 3] || !target.every((v, i) => Math.abs(data[p + i] - v) < 3)) continue;
        const x = (p / 4) % c.width;
        if (x < left) caller++;
        if (x > right) model++;
      }
      return { caller, model };
    }, kind);
    expect(colors.caller).toBe(0);
    expect(colors.model).toBeGreaterThan(0);
  });
}
