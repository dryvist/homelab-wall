import { expect, test } from '@playwright/test';
import { mockFeeds } from './fixture';
import { PAGES, wallUrl } from './panels-contract';

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

const MC4_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
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
        await expect(panels.nth(i)).toHaveAttribute('data-state', /^(ok|pending|error)$/);
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

for (const viewport of MC4_VIEWPORTS) {
  test(`mc4 fits with long fixture titles and many torrents at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    if (!wallUrl) await mockFeeds(page);
    await page.setViewportSize(viewport);
    await page.goto('/mc4/?gl=2d');
    for (const id of ['qbit', 'library', 'plex', 'torrents', 'arr', 'vpn', 'recently-added']) {
      await expect(page.locator(`[data-panel="${id}"]`)).toHaveAttribute('data-state', 'ok');
    }
    await expect(page.locator('#torrents .trow')).toHaveCount(5);
    await expect(page.locator('#torrents')).toContainText('+13 more');
    await expect(page.locator('#torrents .tn').first()).toHaveAttribute('title', 'The Life and Passion of Jesus Christ (1903)');
    await expect(page.locator('#posters .poster')).toHaveCount(8);

    const size = await page.evaluate(() => ({
      scrollWidth: document.scrollingElement!.scrollWidth,
      scrollHeight: document.scrollingElement!.scrollHeight,
      clientWidth: document.scrollingElement!.clientWidth,
      clientHeight: document.scrollingElement!.clientHeight,
      columns: ['#acqbody', '#pipebody'].map((id) => {
        const column = document.querySelector(id)!;
        return { scrollHeight: column.scrollHeight, clientHeight: column.clientHeight };
      }),
    }));
    expect(size.scrollWidth, 'the MC4 page must not scroll horizontally').toBeLessThanOrEqual(size.clientWidth);
    expect(size.scrollHeight, 'the MC4 page must not scroll vertically').toBeLessThanOrEqual(size.clientHeight);
    size.columns.forEach((column, i) => {
      expect(column.scrollHeight, `MC4 card column ${i} content must fit inside its viewport track`).toBeLessThanOrEqual(column.clientHeight);
    });
  });
}
