import { expect, test } from '@playwright/test';
import { mockFeeds } from './fixture';

type Probe = { gl: WebGLRenderingContext | null };
type Win = { __glProbes: Probe[] };

// The rotator keeps every slide loaded, and Chromium drops the oldest WebGL context past 16 live
// ones. hardwareGL() (site/lib/stage.js) must therefore probe once per page and release its probe
// context at once, rather than hold it until garbage collection.
test('hardwareGL probes once per page and releases its probe context', async ({ page }) => {
  await page.addInitScript(() => {
    const probes: Probe[] = [];
    (window as unknown as Win).__glProbes = probes;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      if (type === 'webgl') probes.push({ gl: (ctx as WebGLRenderingContext | null) ?? null });
      return ctx;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await mockFeeds(page);
  // ?gl=2d short-circuits the page's own hardwareGL() call, so this test makes the first one.
  await page.goto('/mc5/?gl=2d');

  const result = await page.evaluate(async () => {
    const probes = (window as unknown as Win).__glProbes;
    const before = probes.length;
    const url = '/lib/stage.js';
    const { hardwareGL } = await import(url);
    const first = hardwareGL();
    const second = hardwareGL();
    const mine = probes.slice(before);
    return {
      same: first === second,
      attempts: mine.length,
      // A browser without WebGL returns no context: nothing is held, which also passes.
      held: mine.filter((p) => p.gl && !p.gl.isContextLost()).length,
    };
  });

  expect(result.same).toBe(true);
  expect(result.attempts).toBe(1);
  expect(result.held).toBe(0);
});
