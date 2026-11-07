import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { config, mockFeeds, words } from './fixture';
import { wallUrl } from './panels-contract';

test('mc5 hero canvas renders non-blank and the org-activity ticker shows rows', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped GitHub response only');
  await mockFeeds(page);
  await page.goto('/mc5/');
  await expect(page.locator('[data-panel="ticker"]')).toHaveAttribute('data-state', 'ok');
  const rows = page.locator('#tickerBody .feed-row');
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#corecanvas').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL().length)).toBeGreaterThan(200);
});

// mc6's strip keeps a tile for EVERY source the page knows about: rows per source come and
// go, but a source absent from this poll renders an explicit NO FEED tile — never omitted.
// The fixture answers five sources (user, claude, codex, zcode and the unknown 'minion'), so
// antigravity and opencode show NO FEED.
test('mc6 renders a tile for every known source, NO FEED where the feed has no rows', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  await mockFeeds(page);
  await page.goto('/mc6/');
  const panel = page.locator('[data-panel="lexicon"]');
  await expect(panel).toHaveAttribute('data-state', 'ok');

  const tiles = page.locator('#strip .tile');
  await expect(tiles).toHaveCount(7); // 6 known sources + the fixture's unknown 'minion'
  for (const [source, label] of [
    ['user', 'OPERATOR'], ['claude', 'CLAUDE'], ['codex', 'CODEX'],
    ['antigravity', 'AGY'], ['zcode', 'ZCODE'], ['opencode', 'OPENCODE'], ['minion', 'MINION'],
  ] as const) {
    const tile = page.locator(`#strip .tile[data-word-source="${source}"]`);
    await expect(tile.locator('.tlabel')).toHaveText(label);
    if (['antigravity', 'opencode'].includes(source)) {
      await expect(tile, `${source} has no rows this poll`).toHaveClass(/nofeed/);
      await expect(tile.locator('.tfeed')).toHaveText('NO FEED');
      await expect(tile.locator('canvas')).toHaveCount(0);
    } else {
      await expect(tile, `${source} has rows this poll`).not.toHaveClass(/nofeed/);
      await expect(tile.locator('canvas')).toHaveCount(1);
      // The tile cloud is real pixels, never a blank canvas.
      await expect.poll(() => tile.locator('canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL().length)).toBeGreaterThan(200);
    }
  }
  // The hero starts on the first source with rows; every source's words come from the feed.
  await expect(page.locator('#herolabel')).toHaveText('OPERATOR');
});

// A poll that fails must not blank the wall: mc6 keeps its last good clouds (lastGood.js,
// mirrored across reloads) and shows the existing stale indicator — dimmed content, amber
// edge, data-state="stale", subtitle "STALE <age>" (mc1's exact pattern).
test('mc6 keeps the last good clouds and shows the stale state when the words feed fails', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the words feed against the fixture server only');
  await mockFeeds(page);
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: { ...config, refreshSeconds: 0.2 } }));
  // The first poll answers at once; every later poll is held until the test has seen the
  // panel reach 'ok', then fails — so the 'ok' state lasts as long as the test needs it to.
  let releaseFailures!: () => void;
  const failuresReleased = new Promise<void>((resolve) => { releaseFailures = resolve; });
  let wordsCalls = 0;
  let failedPolls = 0;
  await page.route('**/api/words', async (r: Route) => {
    wordsCalls += 1;
    if (wordsCalls === 1) return r.fulfill({ json: { meta: [], data: words, rows: words.length } });
    await failuresReleased;
    failedPolls += 1;
    return r.fulfill({ status: 500, json: { error: 'forced failure' } });
  });
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  releaseFailures();
  await expect.poll(() => failedPolls, { message: 'waiting for a second words poll to fail' }).toBeGreaterThan(0);

  const panel = page.locator('[data-panel="lexicon"]');
  await expect(panel).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('#subtitle')).toContainText('STALE');
  // The last good clouds are still on screen — all five data tiles keep their canvases.
  await expect(page.locator('#strip .tile canvas')).toHaveCount(5);
});

// A failure with NO good data ever seen (feed down since boot) is not stale — there is nothing
// to hold over — so the panel stays 'pending' and no tiles or words are fabricated.
test('mc6 stays pending and fabricates nothing when the words feed fails before any good data', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the words feed against the fixture server only');
  await mockFeeds(page, { failWords: true });
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#strip .tile')).toHaveCount(0);
  await expect(page.locator('#herolabel')).toHaveText('');
});

// A poll that SUCCEEDS with zero rows is genuinely empty ("no words yet"), not a failure:
// state 'empty', every known source's tile present and NO FEED, no words anywhere.
test('mc6 renders every known source as NO FEED when the words feed succeeds with zero rows', async ({ page }) => {
  test.skip(!!wallUrl, 'forces an empty words response against the fixture server only');
  await mockFeeds(page, { emptyWords: true });
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'empty');
  const tiles = page.locator('#strip .tile');
  await expect(tiles).toHaveCount(6);
  await expect(page.locator('#strip .tile .tfeed')).toHaveCount(6);
  await expect(page.locator('#strip canvas')).toHaveCount(0);
  await expect(page.locator('#herolabel')).toHaveText('');
});

// The hero cycles the sources every 8s; the strip's highlight and the hero label follow it.
test('mc6 hero cycles to the next source and moves the strip highlight within 10s', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  await mockFeeds(page);
  await page.goto('/mc6/');
  const active = () => page.locator('#strip .tile[data-active]').getAttribute('data-word-source');
  await expect.poll(active).toBe('user');
  await expect.poll(active, { timeout: 12_000, message: 'hero never cycled past OPERATOR' }).not.toBe('user');
  await expect.poll(() => page.locator('#herolabel').textContent(), { timeout: 12_000 }).not.toBe('OPERATOR');
});
