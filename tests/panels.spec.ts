import { expect, test } from '@playwright/test';
import pending from './expected-pending.json' with { type: 'json' };
import { mockFeeds } from './fixture';

const PAGES = [{ id: 'mc1', path: '/mc1/' }] as const;
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
      await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok');
      await expect(page.locator('#appsum')).not.toContainText('—');

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
          expect(await panel.innerText()).not.toMatch(invalidMetric);
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
// mc1.js drawHex — fixed by giving it a CSS-only size, mc1.css), which grew its grid cell
// without bound. No single-screenshot test at DPR 1 caught it. This checks both DPRs the
// operator's real hardware runs at; reduced motion isolates it from the panels' intentional
// decorative sway (mc1.css swayL/swayR), so any remaining drift is a real regression.
for (const deviceScaleFactor of [1, 2] as const) {
  test.describe(`mc1 layout stability at DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor, reducedMotion: 'reduce' });

    test('panel boxes stay fixed and the stage never overflows the viewport', async ({ page }) => {
      if (!wallUrl) await mockFeeds(page);
      await page.goto('/mc1/');
      const panels = page.locator('[data-panel]');
      await expect(panels).not.toHaveCount(0);

      const boxes = () => panels.evaluateAll((els) =>
        els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }));

      const before = await boxes();
      await page.waitForTimeout(4000); // several ticks of the 30fps draw loop that drives the panel canvases
      const after = await boxes();
      before.forEach((b, i) => {
        expect(Math.abs(after[i].w - b.w), `panel ${i} width grew from ${b.w} to ${after[i].w}`).toBeLessThanOrEqual(1);
        expect(Math.abs(after[i].h - b.h), `panel ${i} height grew from ${b.h} to ${after[i].h}`).toBeLessThanOrEqual(1);
      });

      // scrollHeight/scrollWidth report pre-clip content size even under overflow:hidden, so
      // they are not proof of what's on screen. The stage's own post-transform box is: it must
      // sit inside the viewport at (0,0) since fitStage (lib/stage.js) scales from that origin.
      const stage = await page.locator('#stage').boundingBox();
      expect(stage, 'stage element missing').not.toBeNull();
      expect(stage!.x, 'stage left edge outside the viewport').toBeGreaterThanOrEqual(-1);
      expect(stage!.y, 'stage top edge outside the viewport').toBeGreaterThanOrEqual(-1);
      const viewport = page.viewportSize()!;
      expect(stage!.x + stage!.width, 'stage overflows the viewport width').toBeLessThanOrEqual(viewport.width + 1);
      expect(stage!.y + stage!.height, 'stage overflows the viewport height').toBeLessThanOrEqual(viewport.height + 1);
    });
  });
}
