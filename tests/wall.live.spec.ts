// live spec
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

const wallUrl = process.env.WALL_URL;
const wallUser = process.env.WALL_USER;
const wallPassword = process.env.WALL_PASSWORD;

test.skip(!wallUrl, 'WALL_URL enables the live suite');

const CYCLES = 2;
const PIXEL_CHANGE_WINDOW_MS = 10_000;
const OUT_DIR = 'test-results/live';

type SlideConfig = { name: string; url: string; seconds?: number };
const DEFAULT_SLIDES: SlideConfig[] = [
  { name: 'MC1', url: '/mc1/' },
  { name: 'MC2', url: '/mc2/' },
  { name: 'MC3', url: '/mc3/' },
  { name: 'MC4', url: '/mc4/' },
  { name: 'MC5', url: '/mc5/' },
  { name: 'LEXICON', url: '/mc6/' },
];

const safeName = (name: string) => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

// The wall polls its feeds without pause, so networkidle may never arrive: each wait is bounded.
const SETTLE_MS = 15_000;

type LoginResult = 'no-gate' | 'logged-in' | 'gated-no-credentials' | 'login-unconfirmed';

async function loginIfPresented(page: Page): Promise<LoginResult> {
  await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
  const usernameField = page.getByLabel(/username/i).first();
  // isVisible() ignores its timeout and returns at once; waitFor() gives a late login form time to render.
  const onLoginPage = await usernameField.waitFor({ state: 'visible', timeout: SETTLE_MS }).then(() => true, () => false);
  if (!onLoginPage) return 'no-gate';
  if (!wallUser || !wallPassword) return 'gated-no-credentials';
  await usernameField.fill(wallUser);
  await page.getByLabel(/password/i).first().fill(wallPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The form still showing after the bound proves only that sign-in was not confirmed in time:
  // the gate may have rejected the credentials, or it may be slow.
  const leftLoginPage = await usernameField.waitFor({ state: 'hidden', timeout: SETTLE_MS }).then(() => true, () => false);
  if (!leftLoginPage) return 'login-unconfirmed';
  await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
  return 'logged-in';
}

async function canvasSnapshots(frame: FrameLocator): Promise<string[]> {
  return frame.locator('canvas').evaluateAll((canvases) =>
    (canvases as HTMLCanvasElement[]).map((c) => c.toDataURL()));
}

test('the rotator shows every configured slide, non-blank, with panels that keep moving', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000);

  await page.goto(wallUrl!);
  const loginResult = await loginIfPresented(page);
  testInfo.attach('login', { body: loginResult });
  expect(loginResult, 'gate present, no credentials supplied').not.toBe('gated-no-credentials');
  expect(loginResult, `sign-in not confirmed within ${SETTLE_MS} ms: credentials rejected or the gate is slow`).not.toBe('login-unconfirmed');

  const config = await page.evaluate(async () => {
    try {
      const res = await fetch('/config.json', { cache: 'no-store' });
      return await res.json();
    } catch {
      return {};
    }
  }) as { slides?: SlideConfig[] };
  const slides = config.slides?.length ? config.slides : DEFAULT_SLIDES;
  const configuredNames = new Set(slides.map((s) => s.name));

  // The rotator's buildLayers() fills #layers with fixed-position iframes, so #layers has no box of
  // its own: wait for the first layer iframe to be attached.
  await page.waitForSelector('#layers iframe.layer', { state: 'attached', timeout: 30_000 });
  const dots = page.locator('#dots');

  const shown = new Map<string, number>();
  const skipped = new Set<string>();
  const screenshots: string[] = [];

  const perSlideMs = Math.max(...slides.map((s) => (s.seconds ?? 10) * 1000), 10_000);
  const budgetMs = perSlideMs * slides.length * CYCLES + 30_000;
  const deadline = Date.now() + budgetMs;

  let lastActiveSrc = '';
  while (Date.now() < deadline) {
    const skippedAttr = await dots.getAttribute('data-skipped');
    if (skippedAttr) skipped.add(skippedAttr);

    const activeLayer = page.locator('.layer.active');
    const src = await activeLayer.getAttribute('src').catch(() => null);
    if (src && src !== lastActiveSrc) {
      lastActiveSrc = src;
      const name = (await activeLayer.getAttribute('title').catch(() => null)) || src;
      const seen = (shown.get(name) ?? 0) + 1;
      shown.set(name, seen);

      const shotPath = `${OUT_DIR}/${safeName(name)}-${seen}.png`;
      await page.screenshot({ path: shotPath }).catch(() => {});
      screenshots.push(shotPath);

      const frame = page.frameLocator('.layer.active');
      const before = await canvasSnapshots(frame).catch(() => []);
      expect(
        before.every((d) => d.length > 200),
        `${name} rendered a blank canvas`,
      ).toBe(true);

      const slideSeconds = slides.find((s) => s.name === name)?.seconds ?? 10;
      if (before.length > 0 && slideSeconds * 1000 >= PIXEL_CHANGE_WINDOW_MS + 1000) {
        await page.waitForTimeout(PIXEL_CHANGE_WINDOW_MS);
        const stillActive = await activeLayer.getAttribute('src').catch(() => null);
        if (stillActive === src) {
          const after = await canvasSnapshots(frame).catch(() => []);
          expect(
            after.some((d, i) => d !== before[i]),
            `${name}'s panels did not change pixels within ${PIXEL_CHANGE_WINDOW_MS}ms`,
          ).toBe(true);
        }
      }
    }

    if (shown.size >= configuredNames.size && [...shown.values()].every((n) => n >= CYCLES)) break;
    await page.waitForTimeout(1000);
  }

  const report = {
    shown: Object.fromEntries(shown),
    skipped: [...skipped],
    screenshots,
    loginResult,
  };
  await testInfo.attach('live-run-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

  for (const name of configuredNames) {
    expect(shown.has(name), `${name} was never shown during the run`).toBe(true);
  }
});
