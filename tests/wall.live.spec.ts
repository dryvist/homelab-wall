import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// Runs the rotator (site/rotator/rotator.js) against WALL_URL instead of the synthetic fixture
// every other spec uses. Opt-in only: `npx playwright test --project=live` (see
// playwright.config.ts; excluded from the default project set every other CI run exercises).
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
];

const safeName = (name: string) => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

// Authelia's own login form (labeled fields, no stable custom IDs relied on). No-op when the
// wall is already reachable without a gate, or when no credentials were supplied — the caller
// decides what a still-gated page after this returns means for its own assertions.
async function loginIfPresented(page: Page): Promise<'no-gate' | 'logged-in' | 'gated-no-credentials'> {
  // Authelia's own SPA takes longer than a bare navigation to mount its login form — wait for
  // the page to settle before deciding whether a gate is even present, or a slow first paint
  // reads as "no gate" and the run silently skips straight to a page that was never reachable.
  await page.waitForLoadState('networkidle').catch(() => {});
  const usernameField = page.getByLabel(/username/i).first();
  const onLoginPage = await usernameField.isVisible({ timeout: 15_000 }).catch(() => false);
  if (!onLoginPage) return 'no-gate';
  if (!wallUser || !wallPassword) return 'gated-no-credentials';
  await usernameField.fill(wallUser);
  await page.getByLabel(/password/i).first().fill(wallPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForLoadState('networkidle').catch(() => {});
  return 'logged-in';
}

// Every canvas the slide currently renders (its "panel regions") must both hold real pixels now
// and keep moving — A3 (site/lib/stage.js) holds the last real sample and jitters around it
// forever, so no live panel is ever allowed to sit frozen.
async function canvasSnapshots(frame: FrameLocator): Promise<string[]> {
  return frame.locator('canvas').evaluateAll((canvases) =>
    (canvases as HTMLCanvasElement[]).map((c) => c.toDataURL()));
}

test('the rotator shows every configured slide, non-blank, with panels that keep moving', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000);

  await page.goto(wallUrl!);
  const loginResult = await loginIfPresented(page);
  testInfo.attach('login', { body: loginResult });
  // Fail fast, with the actual reason, instead of a generic "#layers never appeared" timeout
  // once the rotator's own markup never loads behind an un-passable gate.
  expect(loginResult, 'WALL_URL is gated by Authelia and WALL_USER/WALL_PASSWORD were not set').not.toBe('gated-no-credentials');

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

  await page.waitForSelector('#layers', { timeout: 30_000 });
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

      // Only worth checking motion if the slide is due to stay on screen long enough to see it.
      const slideSeconds = slides.find((s) => s.name === name)?.seconds ?? 10;
      if (before.length > 0 && slideSeconds * 1000 >= PIXEL_CHANGE_WINDOW_MS + 1000) {
        await page.waitForTimeout(PIXEL_CHANGE_WINDOW_MS);
        // The slide may have rotated away while we waited; only compare if it's still active
        // (the frameLocator re-resolves '.layer.active' live, so this guards against silently
        // comparing against a different slide's canvases).
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
