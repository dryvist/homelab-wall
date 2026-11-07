import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { config, mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';
import { drawnHero } from './panels-words-helpers';

// Maximum input: six known sources with 200 words each. Source s holds terms s*160 .. s*160+199
// (mod 1000), so the union is 1,000 distinct terms and neighbouring sources share forty of them.
const maxWords = ['user', 'claude', 'codex', 'antigravity', 'zcode', 'opencode'].flatMap((source, s) =>
  Array.from({ length: 200 }, (_, i) => ({ source, word: `term${(s * 160 + i) % 1000}`, n: String(1000 - i) })));

// One hook sample per animation frame: layouts and refreshes so far, gradients built so far, the
// canvas width and the displayed view.
type Frame = { t: number; L: number; R: number; fills: number; backdrops: number; cw: number; view: string | null };

// Median frame interval bounds in ms, per environment and chromium project, for the steady window and
// for the CONVERGENCE transition. Local (CI unset): 25ms everywhere, and 40ms for the transition at
// 2560x1440. CI (GitHub-hosted runners, CI set): 60ms steady and 140ms transition at both sizes. The CI
// bounds were set from measured CI medians of 66.6ms (transition, 1920x1080) and 33.3ms (steady,
// 2560x1440), and catch regressions of roughly 2x or more on a shared CPU runner. The local bounds are
// the kiosk target.
const FRAME_MS = {
  local: {
    'chromium-1920x1080@1': { steady: 25, transition: 25 },
    'chromium-2560x1440': { steady: 25, transition: 40 },
  },
  ci: {
    'chromium-1920x1080@1': { steady: 60, transition: 140 },
    'chromium-2560x1440': { steady: 60, transition: 140 },
  },
};

// At maximum input a refresh lays the clouds out only when the words change. Refreshes run every
// second here. Over a steady 3s window of identical refreshes no layout runs. A refresh that reads one
// changed word lays out seven clouds: six strip tiles and the hero's current view. Layout counts and
// gradient builds are hard assertions in every environment. The steady and transition medians are
// checked last, against the FRAME_MS bounds for the environment and project.
test('mc6 at maximum input relays out only on changed words; median frames stay under their FRAME_MS bounds (local 25ms, 40ms at 2560 transition; CI 60ms steady, 140ms transition)', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the words feed against the fixture server only');
  test.skip(!(test.info().project.name in FRAME_MS.local), 'chromium at 1920x1080 and 2560x1440 only');
  const bound = (process.env.CI ? FRAME_MS.ci : FRAME_MS.local)[test.info().project.name as keyof typeof FRAME_MS.local];
  test.setTimeout(150_000);
  await mockFeeds(page);
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: { ...config, refreshSeconds: 1 } }));
  // The feed answers the maximum input until the changed-words step below, which adds one word.
  let feed = maxWords;
  await page.route('**/api/words', (r: Route) => r.fulfill({ json: { meta: [], data: feed, rows: feed.length } }));
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  // Opens the window just after a slot change, once the transition has settled, so no slot change
  // or transition falls inside the 3s measured below.
  await expect.poll(async () => (await drawnHero(page))?.view ?? null, { message: 'hero never drew' }).not.toBeNull();
  const first = (await drawnHero(page))?.view;
  await expect.poll(async () => (await drawnHero(page))?.view ?? null, { timeout: 15_000, message: 'hero never changed slot' }).not.toBe(first);
  await page.waitForTimeout(1500);

  // One sample per animation frame, from now until the hero has shown CONVERGENCE for 1.6s. The first
  // 3s are the steady window; the glide, disperse and condense transition runs for FADE_MS (1.4s)
  // from the switch to CONVERGENCE.
  const frames = await page.evaluate(() => new Promise<Frame[]>((resolve) => {
    const w = window as unknown as { __mc6: { stats(): { refreshes: number; layouts: number; fills: number; backdrops: number; view: string | null } } };
    const canvas = document.getElementById('cloudhero') as HTMLCanvasElement;
    const samples: Frame[] = [];
    let switchAt: number | null = null;
    const tick = (t: number) => {
      const s = w.__mc6.stats();
      samples.push({ t, L: s.layouts, R: s.refreshes, fills: s.fills, backdrops: s.backdrops, cw: canvas.width, view: s.view });
      if (switchAt === null && s.view === 'CONVERGENCE') switchAt = t;
      if (switchAt !== null && t - switchAt >= 1600) resolve(samples);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  const steady = frames.filter((f) => f.t - frames[0].t <= 3000);
  const m = frames.findIndex((f) => f.view === 'CONVERGENCE');
  expect(m, 'the hero switched to CONVERGENCE').toBeGreaterThan(0);
  const transition = frames.slice(m).filter((f) => f.t - frames[m].t <= 1400);
  expect(transition.length, 'frames inside the transition window').toBeGreaterThanOrEqual(10);

  const refreshes = steady[steady.length - 1].R - steady[0].R;
  const layouts = steady[steady.length - 1].L - steady[0].L;
  const medianOf = (xs: Frame[]) => {
    const gaps = xs.slice(1).map((f, i) => f.t - xs[i].t).sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  };
  // A word fill is built only on a frame that lays out; a backdrop only on one that lays out or resizes
  // the canvas. Frames that lay out are excluded: their gradients are the layout's own.
  const createdWithoutLayout = (xs: Frame[]) => xs.slice(1).filter((f, i) => {
    const p = xs[i];
    return (f.fills > p.fills && f.L === p.L) || (f.backdrops > p.backdrops && f.L === p.L && f.cw === p.cw);
  }).length;
  const steadyMedian = medianOf(steady);
  const transitionMedian = medianOf(transition);
  const laidOut = transition.slice(1).filter((f, i) => f.L !== transition[i].L).length;
  const built = transition.slice(1).filter((f, i) => f.fills > transition[i].fills || f.backdrops > transition[i].backdrops).length;
  // Both medians are recorded before any assertion, so every run prints them, whichever check fails.
  const medians = `steady ${steadyMedian.toFixed(1)}ms (bound ${bound.steady}ms), transition ${transitionMedian.toFixed(1)}ms (bound ${bound.transition}ms)`;
  test.info().annotations.push({ type: 'measured', description: `steady median ${steadyMedian}ms; transition median ${transitionMedian}ms over ${transition.length} frames, ${laidOut} of them laid out, ${built} built a gradient` });
  test.info().annotations.push({ type: 'frame-median', description: medians });
  console.log(`frame-median ${test.info().project.name}: ${medians}`);

  expect(refreshes, 'refreshes during the 3s window').toBeGreaterThanOrEqual(2);
  expect(layouts, 'layouts during identical-words refreshes in the 3s window').toBe(0);
  expect(createdWithoutLayout(steady), 'steady frames that create a gradient without a layout').toBe(0);
  expect(createdWithoutLayout(transition), 'transition frames that create a gradient without a layout').toBe(0);

  // The feed gains one word as the sampler starts. The sampler runs for 2.5s, which covers the refresh
  // that reads the new words and at least one more that reads the same words again.
  const changedFrames = page.evaluate(() => new Promise<Frame[]>((resolve) => {
    const w = window as unknown as { __mc6: { stats(): { refreshes: number; layouts: number; fills: number; backdrops: number; view: string | null } } };
    const canvas = document.getElementById('cloudhero') as HTMLCanvasElement;
    const samples: Frame[] = [];
    const start = performance.now();
    const tick = (t: number) => {
      const s = w.__mc6.stats();
      samples.push({ t, L: s.layouts, R: s.refreshes, fills: s.fills, backdrops: s.backdrops, cw: canvas.width, view: s.view });
      if (t - start < 2500) requestAnimationFrame(tick);
      else resolve(samples);
    };
    requestAnimationFrame(tick);
  }));
  feed = [...maxWords, { source: 'user', word: 'fresh', n: '999' }];
  const changed = await changedFrames;
  const changedRefreshes = changed.slice(1).flatMap((f, i) => (f.R !== changed[i].R
    ? [{ layouts: f.L - changed[i].L, sameView: f.view === changed[i].view }]
    : []));
  expect(changedRefreshes.length, 'refreshes in the 2.5s window after the change').toBeGreaterThanOrEqual(2);
  expect(changedRefreshes.filter((r) => r.layouts > 0).map((r) => r.layouts), 'layouts per refresh that reads changed words').toEqual([7]);
  expect(changedRefreshes.filter((r) => r.layouts === 0).length, 'refreshes that lay out nothing').toBeGreaterThanOrEqual(1);
  expect(changedRefreshes.every((r) => r.sameView), 'the displayed view held across those refreshes').toBe(true);

  // Timing last, and soft, so a steady failure still reports the transition median.
  expect.soft(steadyMedian, 'median steady frame interval (ms)').toBeLessThan(bound.steady);
  expect.soft(transitionMedian, 'median transition frame interval (ms)').toBeLessThan(bound.transition);
});
