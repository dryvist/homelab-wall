import { test, expect } from '@playwright/test';
import { highCardinalityRows, mockMc8, mc8Answer } from './mc8.fixture';
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
  await expect(page.locator('#local-share')).toHaveText(/69[.,]2%/);
  await expect(page.locator('#in-flight')).toHaveText('7');
  await expect(page.locator('#spend')).toHaveText(/123[.,]4¢/);
  await expect(page.locator('#ttft')).toHaveText('420 ms');
  await expect(page.locator('#route-state')).toHaveText('130 tokens/s');
  expect(await page.locator('[data-source="stand-in"]').count()).toBe(0);
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
  await expect(page.locator('#callers .terminal').first()).toContainText('caller-20');

  const callerMore = page.locator('#callers .more strong');
  const callerCount = Number((await callerMore.innerText()).match(/^\+(\d+) more$/)?.[1]);
  const visibleCallers = await page.locator('#callers .terminal:not(.more)').count();
  expect(Number.isInteger(callerCount)).toBe(true);
  expect(callerCount + visibleCallers).toBe(20);

  const modelMore = page.locator('#models .more strong');
  const modelCount = Number((await modelMore.innerText()).match(/^\+(\d+) more$/)?.[1]);
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
  await mockMc8(page, { rows: highCardinalityRows, failure: true });
  await page.goto('/mc8/');
  await expect(page.locator('#models .more .failure-marker')).toHaveText('Failures · last minute');
});

test('empty data remains pending and draws no sample routes or numeric heroes', async ({ page }) => {
  await mockMc8(page, { empty: true });
  await page.goto('/mc8/');
  await expect(page.locator('#flow-status')).toContainText('Pending');
  await expect(page.locator('.terminal')).toHaveCount(0);
  await expect(page.locator('.reading')).toHaveText(['Pending', 'Pending', 'Pending', 'Pending']);
});

test('an empty TTFT result reads Idle while its histogram sample time is fresh', async ({ page }) => {
  await mockMc8(page, { idleTtft: true });
  await page.goto('/mc8/');
  await expect(page.locator('#ttft')).toHaveText('Idle');
  await expect(page.locator('[data-panel]:has(#ttft) .status')).toHaveText('Idle · no samples in the trailing 5 minutes');
  await expect(page.locator('#in-flight')).toHaveText('7');
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
  await expect(page.locator('#in-flight')).toHaveText('7');
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
  await expect(page.locator('#ttft')).toHaveText('420 ms');
  expect(calls).toEqual([]);
});

test('old snapshot samples stay stale after repeated successful fetches and never mark failures', async ({ page }) => {
  await mockMc8(page, { snapshot: true });
  const instant = Object.fromEntries(Object.entries(Q).filter(([key]) => key.startsWith('mc8')).map(([key, expr]) => {
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
  const instant = Object.fromEntries(Object.entries(Q).filter(([key]) => key.startsWith('mc8')).map(([key, expr]) => {
    const result = mc8Answer(expr);
    for (const row of result) {
      if (key.endsWith('Rate')) row.metric = { ...row.metric, ...unclassified };
      if (key.endsWith('SourceTime')) row.value[1] = String(Date.now() / 1000 - 301);
    }
    return [key, { result }];
  }));
  await page.route('**/data/mc8.json', (r) => r.fulfill({ json: { generated_at: new Date().toISOString(), instant } }));
  await page.goto('/mc8/');
  await expect(page.locator('#local-share')).toHaveText('Unavailable');
  await expect(page.locator('#unclassified-share')).toContainText('unclassified 100%');
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
  await expect(page.locator('#route-state')).toHaveText('Idle');
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
