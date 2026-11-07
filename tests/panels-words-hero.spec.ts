import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { config, mockFeeds, words } from './fixture';
import { wallUrl } from './panels-contract';
import { heroWordPixels, drawnHero, heroWords } from './panels-words-helpers';

test('mc6 hero draws the active source words around the middle of its canvas', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the words feed against the fixture server only');
  await mockFeeds(page);
  await page.route('**/api/words', (r: Route) => r.fulfill({ json: { meta: [], data: heroWords, rows: heroWords.length } }));
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  await expect.poll(async () => {
    const { count, cx, cy } = await heroWordPixels(page);
    if (count < 1000) return 'blank';
    return cx > 0.3 && cx < 0.7 && cy > 0.3 && cy < 0.7 ? 'centred' : `off-centre (${cx.toFixed(2)}, ${cy.toFixed(2)})`;
  }, { message: 'hero words drawn around the canvas middle' }).toBe('centred');
});

// A poll that changes the words of the source the hero is showing reaches the hero on the next
// frame, not at the next 8s slot change. The first poll answers one word; the later polls are
// held until the test has measured the hero, then answer forty.
test('mc6 hero redraws the displayed source when a poll changes its words', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the words feed against the fixture server only');
  await mockFeeds(page);
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: { ...config, refreshSeconds: 1 } }));
  let releaseLaterPolls!: () => void;
  const laterPollsReleased = new Promise<void>((resolve) => { releaseLaterPolls = resolve; });
  const firstWords = [{ source: 'user', word: 'alpha', n: '10' }];
  let wordsCalls = 0;
  await page.route('**/api/words', async (r: Route) => {
    wordsCalls += 1;
    const call = wordsCalls;
    if (call > 1) await laterPollsReleased;
    const data = call === 1 ? firstWords : heroWords;
    return r.fulfill({ json: { meta: [], data, rows: data.length } });
  });
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  await expect.poll(async () => (await heroWordPixels(page)).count, { message: 'hero never drew the first poll' }).toBeGreaterThan(200);
  const before = (await heroWordPixels(page)).count;

  releaseLaterPolls();
  await expect.poll(async () => (await heroWordPixels(page)).count, { message: 'hero kept the first poll words' }).toBeGreaterThan(before * 2);
});

// A word two sources both hold ('deploy': the operator and codex in the fixture) is listed as
// shared in the panel header.
test('mc6 marks a word held by two sources as shared', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  await mockFeeds(page);
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#shared')).toContainText('deploy');
});

// The hero rotation ends on a CONVERGENCE view after the last source with rows. The fake clock
// advances past the five sources' 8s slots; the line under the label names the operator-and-agent
// vocabulary ('deploy' in the fixture).
test('mc6 hero rotation ends on a CONVERGENCE view of every source', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.clock.install();
  await mockFeeds(page);
  await page.goto('/mc6/');
  const label = page.locator('#herolabel');
  await expect(label).toHaveText('OPERATOR');
  await page.clock.fastForward(5 * 8000 + 500);
  await expect(label).toHaveText('CONVERGENCE');
  await expect(page.locator('#herosub')).toContainText('SHARED VOCAB');
  await expect(page.locator('#herosub')).toContainText('deploy');
  // The merged view paints ink, and every fixture source with rows shows up among the drawn words.
  await expect.poll(async () => (await heroWordPixels(page)).count, { message: 'CONVERGENCE canvas stays blank' }).toBeGreaterThan(1000);
  const drawn = await drawnHero(page);
  expect(drawn?.view).toBe('CONVERGENCE');
  const withRows = [...new Set(words.map((w) => w.source))].sort();
  expect([...new Set(drawn?.words.flatMap((w) => w.sources))].sort(), 'sources among the drawn words').toEqual(withRows);
  // Asserts the merged view draws without a page error.
  expect(pageErrors).toEqual([]);
});

// A digest of every pixel of the hero canvas: equal digests mean the canvas did not change.
async function heroPixelDigest(page: Page) {
  return page.locator('#cloudhero').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let digest = 0;
    for (let i = 0; i < data.length; i += 1) digest = (Math.imul(digest, 31) + data[i]) | 0;
    return digest;
  });
}

// The hero paints real pixels and keeps moving with no data change: the canvas is non-blank, and
// its pixels differ across a 3 s window (the breathing scale and drift).
test('mc6 hero canvas is non-blank and keeps changing while idle', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  await mockFeeds(page);
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  await expect.poll(async () => (await heroWordPixels(page)).count, { message: 'hero canvas stays blank' }).toBeGreaterThan(1000);
  const before = await heroPixelDigest(page);
  await page.waitForTimeout(3000);
  expect(await heroPixelDigest(page), 'hero pixels unchanged over 3s').not.toBe(before);
});

// The hook's rank mapping for the operator's view: the top-ranked word ('deploy', n 412) is larger
// and lighter than the bottom-ranked one ('certificate', n 55), and 'deploy', also held by codex,
// reports a fill that runs across both sources.
test('mc6 maps rank to size and lightness, and a shared word to a multi-source fill', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  await page.clock.install();
  await mockFeeds(page);
  await page.goto('/mc6/');
  await expect(page.locator('#herolabel')).toHaveText('OPERATOR');
  await expect.poll(async () => (await drawnHero(page))?.words.map((w) => w.text) ?? [], { message: 'operator view never drew deploy and certificate' }).toEqual(expect.arrayContaining(['deploy', 'certificate']));
  const words = (await drawnHero(page))?.words ?? [];
  const top = words.find((w) => w.text === 'deploy')!;
  const bottom = words.find((w) => w.text === 'certificate')!;
  expect(top.size, 'top-ranked word size').toBeGreaterThan(bottom.size);
  expect(top.lightness, 'top-ranked word lightness').toBeGreaterThan(bottom.lightness);
  expect(top.sources).toEqual(expect.arrayContaining(['user', 'codex']));
  expect(top.fill).toBe('gradient');
});
