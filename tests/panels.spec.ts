import { expect, test } from '@playwright/test';
import pendingJson from './expected-pending.json' with { type: 'json' };
import { mockFeeds } from './fixture';

// Record<string, string[]> keyed by page id (not just mc1's own keys) so a page id not yet in
// the fixture still typechecks — it simply has no allowed-pending panels.
const pending = pendingJson as { panels: Record<string, string[]>; queries: string[] };

const PAGES = [
  { id: 'mc1', path: '/mc1/' },
  { id: 'mc2', path: '/mc2/' },
  { id: 'mc3', path: '/mc3/' },
  { id: 'mc4', path: '/mc4/' },
  { id: 'mc5', path: '/mc5/' },
] as const;
const MODES = ['2d', '3d'] as const;
const invalidMetric = /NaN|undefined|null|Infinity|—/;
// WALL_URL targets the live site instead of the fixture; skip the mock and its fixture-shaped assertions.
const wallUrl = process.env.WALL_URL;

for (const pageSpec of PAGES) {
  for (const mode of MODES) {
    test(`${pageSpec.id} ${mode} panels honor the data contract`, async ({ page }) => {
      const faults: string[] = [];
      page.on('pageerror', (error) => faults.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') faults.push(message.text());
      });
      page.on('requestfailed', (request) => faults.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
      page.on('response', (response) => {
        if (response.status() >= 400) faults.push(`${response.status()} ${response.url()}`);
      });

      if (!wallUrl) await mockFeeds(page);
      await page.goto(`${pageSpec.path}?gl=${mode}`);
      const panels = page.locator('[data-panel]');
      await expect(panels).not.toHaveCount(0);

      // Every panel on the page must be 'ok' unless this page's expected-pending.json entry
      // lists it — generic across pages, no panel id (e.g. mc1's "apps") is special-cased here.
      const allowed = new Set(pending.panels[pageSpec.id] ?? []);
      const count = await panels.count();
      for (let index = 0; index < count; index += 1) {
        const panel = panels.nth(index);
        const id = await panel.getAttribute('data-panel');
        expect(id).not.toBeNull();
        const state = await panel.getAttribute('data-state');
        if (allowed.has(id!)) {
          expect(state).toBe('pending');
          await expect(panel).toContainText(/[A-Z]{2,}/);
        } else {
          expect(state).toBe('ok');
          // Poll, not a one-shot read: a panel can flip to data-state="ok" (set synchronously
          // by renderStatic) a frame before its own rAF-scheduled repaint (e.g. mc1's #appsum)
          // has actually painted over its placeholder "—".
          await expect.poll(() => panel.innerText()).not.toMatch(invalidMetric);
        }
      }

      const labels = await page.locator('.node .nm, .st > span:first-child, .lr > span:first-of-type').allTextContents();
      const normalized = labels.map((label) => label.trim()).filter(Boolean);
      expect(new Set(normalized).size).toBe(normalized.length);

      // D2 (ansible-side defect, fixture-forced here): a node's subtitle must never echo its
      // own name back — that means the upstream role mapping is broken, not informative.
      const nodeNames = await page.locator('.node .nm').evaluateAll((els) =>
        els.map((el) => el.childNodes[0]?.textContent?.trim().toLowerCase() ?? ''));
      const nodeMetas = await page.locator('.node .nm em').allTextContents();
      nodeMetas.forEach((meta, i) => {
        expect(meta.toLowerCase(), `node "${nodeNames[i]}" subtitle must not restate its own name`).not.toContain(nodeNames[i]);
      });

      // D3: a device shared by several nodes (same device + mountpoint) collapses to one
      // storage row, not one per node. Fixture-shaped, so only checked against the fixture.
      if (!wallUrl && pageSpec.id === 'mc1') {
        expect(await page.locator('#strows .st').count(), 'a shared mount must be deduped to a single row').toBe(7);
      }

      // mc1-only: the service-health strip's own summary line is content, not just panel
      // state — the generic loop above already requires [data-panel="apps"] to be 'ok'.
      if (pageSpec.id === 'mc1') {
        await expect(page.locator('#appsum')).not.toContainText('—');
      }

      await expect.poll(() => page.locator('canvas').evaluateAll((canvases) => Array.from(canvases).every((canvas) =>
        canvas instanceof HTMLCanvasElement && canvas.toDataURL().length > 200,
      ))).toBe(true);

      const overlaps = await panels.evaluateAll((elements) => (elements as HTMLElement[]).flatMap((element, index) => {
        const a = { left: element.offsetLeft, top: element.offsetTop, right: element.offsetLeft + element.offsetWidth, bottom: element.offsetTop + element.offsetHeight };
        return (elements as HTMLElement[]).slice(index + 1).flatMap((other) => {
          const b = { left: other.offsetLeft, top: other.offsetTop, right: other.offsetLeft + other.offsetWidth, bottom: other.offsetTop + other.offsetHeight };
          return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
            ? [[element.getAttribute('data-panel'), other.getAttribute('data-panel')]]
            : [];
        });
      }));
      expect(overlaps).toEqual([]);
      expect(faults).toEqual([]);
      await page.screenshot({ path: `test-results/${pageSpec.id}-${mode}.png` });
    });
  }
}

// A canvas read its own rendered size back into its own backing-store resolution (#hex,
// mc1.js drawHex — fixed by giving it a CSS-only size, decoupled from the layout via
// lib/stage.js observeCanvas), which grew its grid cell without bound. No single-screenshot
// test at 1920x1080@1 caught it, and it was WebKit-only in the field, so this runs on every
// configured project (Chromium and WebKit, playwright.config.ts) across a small viewport/DPR/
// aspect matrix, including a portrait one. Reduced motion isolates the check from the panels'
// intentional decorative sway (mc1.css swayL/swayR), so any remaining drift is a regression.
const STABILITY_MATRIX = [
  { width: 1280, height: 720, deviceScaleFactor: 1 },
  { width: 1920, height: 1080, deviceScaleFactor: 2 },
  { width: 2560, height: 1440, deviceScaleFactor: 2 },
  { width: 1080, height: 1920, deviceScaleFactor: 1 },
] as const;

for (const vp of STABILITY_MATRIX) {
  test.describe(`mc1 layout stability at ${vp.width}x${vp.height}@${vp.deviceScaleFactor}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, reducedMotion: 'reduce' });

    test('every panel fits the viewport, stays stable, has no overlap, and reports ok or an explicit error', async ({ page }) => {
      if (!wallUrl) await mockFeeds(page);
      await page.goto('/mc1/');
      const panels = page.locator('[data-panel]');
      await expect(panels).not.toHaveCount(0);
      const count = await panels.count();

      // never a silently blank panel: it's ok, declared-pending, or an explicit error.
      for (let i = 0; i < count; i += 1) {
        expect(['ok', 'pending', 'error']).toContain(await panels.nth(i).getAttribute('data-state'));
      }

      // offsetLeft/Top/Width/Height (not getBoundingClientRect) — the grid's actual box,
      // ignoring the panels' intentional decorative 3D sway (mc1.css #nodes/#storage/...
      // rotateY), which getBoundingClientRect would report as a wider, post-transform box and
      // flag as a false overlap between adjacent cells. The data-contract test above uses the
      // same metric for the same reason.
      const boxes = () => panels.evaluateAll((els) =>
        els.map((el) => ({ x: (el as HTMLElement).offsetLeft, y: (el as HTMLElement).offsetTop, w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight })));

      const before = await boxes();
      await page.waitForTimeout(4000); // several ticks of the 30fps draw loop that drives the panel canvases
      const after = await boxes();
      before.forEach((b, i) => {
        expect(Math.abs(after[i].w - b.w), `panel ${i} width drifted from ${b.w} to ${after[i].w}`).toBeLessThanOrEqual(1);
        expect(Math.abs(after[i].h - b.h), `panel ${i} height drifted from ${b.h} to ${after[i].h}`).toBeLessThanOrEqual(1);
      });

      const viewport = page.viewportSize()!;
      after.forEach((b, i) => {
        expect(b.x, `panel ${i} left edge outside the viewport`).toBeGreaterThanOrEqual(-1);
        expect(b.y, `panel ${i} top edge outside the viewport`).toBeGreaterThanOrEqual(-1);
        expect(b.x + b.w, `panel ${i} overflows the viewport width`).toBeLessThanOrEqual(viewport.width + 1);
        expect(b.y + b.h, `panel ${i} overflows the viewport height`).toBeLessThanOrEqual(viewport.height + 1);
      });

      const overlaps = await panels.evaluateAll((elements) => (elements as HTMLElement[]).flatMap((element, index) => {
        const a = { left: element.offsetLeft, top: element.offsetTop, right: element.offsetLeft + element.offsetWidth, bottom: element.offsetTop + element.offsetHeight };
        return (elements as HTMLElement[]).slice(index + 1).flatMap((other) => {
          const b = { left: other.offsetLeft, top: other.offsetTop, right: other.offsetLeft + other.offsetWidth, bottom: other.offsetTop + other.offsetHeight };
          return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
            ? [[element.getAttribute('data-panel'), other.getAttribute('data-panel')]]
            : [];
        });
      }));
      expect(overlaps).toEqual([]);
    });
  });
}

// The operator saw the page grow taller than the viewport in Safari — a WebKit-only feedback
// loop (a canvas reading its own rendered size back into its backing store, which then grew its
// grid cell). document.scrollingElement.scrollHeight is the direct measure of that: the page
// must never exceed the viewport, on any project, and must stay put once settled.
for (const pageSpec of PAGES) {
  test(`${pageSpec.id} page height never exceeds the viewport and stays stable`, async ({ page }) => {
    if (!wallUrl) await mockFeeds(page);
    await page.goto(pageSpec.path);
    const viewport = page.viewportSize()!;
    const heights: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      heights.push(await page.evaluate(() => document.scrollingElement!.scrollHeight));
      if (i < 4) await page.waitForTimeout(1000);
    }
    heights.forEach((h, i) => {
      expect(h, `scrollHeight ${h}px exceeds viewport height ${viewport.height}px at t=${i}s`).toBeLessThanOrEqual(viewport.height);
    });
    expect(new Set(heights).size, `scrollHeight was not stable over 5s: ${heights.join(', ')}`).toBe(1);
  });
}

// settle() (lib/prom.js) turns a rejected query into null, and mc1.js renders that as an
// explicit error panel — never as "0 OK / 54 NO DATA" (the bug the operator saw). Forces the
// score query to fail outright and asserts the panel says so.
test('a failed health query renders an explicit error, never a silent zero count', async ({ page }) => {
  test.skip(!!wallUrl, 'forces a query failure against the fixture server only');
  await mockFeeds(page, { failQuery: (q) => q.includes('gatus_results_total') && q.includes('by (name)') });
  await page.goto('/mc1/');
  const apps = page.locator('[data-panel="apps"]');
  await expect(apps).toHaveAttribute('data-state', 'error');
  await expect(apps.locator('[data-panel-message]')).toHaveText('SCORE QUERY FAILED');
  await expect(page.locator('#appsum')).not.toContainText(/\d/);
});
