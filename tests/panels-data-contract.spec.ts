import { expect, test } from '@playwright/test';
import { mockFeeds } from './fixture';
import { PAGES, MODES, pending, invalidMetric, wallUrl } from './panels-contract';

for (const pageSpec of PAGES) {
  for (const mode of MODES) {
    test(`${pageSpec.id} ${mode} panels honor the data contract`, async ({ page }) => {
      // A forced 3D page runs WebGL2 on CI's software rasterizer, where the first painted frame, and the
      // first poll's render behind it, take far longer than on the wall's GPU; mc3's core is the slowest.
      const slowFirstFrame = mode === '3d';
      if (slowFirstFrame) test.slow();
      const firstState = { timeout: slowFirstFrame ? 15_000 : 5_000 };
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
        // Web-first assertion: the state is set once the panel's feed resolves, not on insert.
        if (allowed.has(id!)) {
          await expect(panel).toHaveAttribute('data-state', 'pending', firstState);
          // A permanently-pending panel is marked data-source stand-in (invisible) and still has
          // real-looking content, never a blank panel — no visible marker distinguishes it. mc1's
          // "nodes" panel is the one exception: it's pending only while its GPU feed has no series,
          // and its node cards still show real data, so it stays data-source 'live'.
          if (!(pageSpec.id === 'mc1' && id === 'nodes')) {
            await expect(panel).toHaveAttribute('data-source', 'stand-in');
          }
          await expect.poll(() => panel.innerText()).not.toBe('');
        } else {
          await expect(panel).toHaveAttribute('data-state', 'ok', firstState);
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
      )), { timeout: slowFirstFrame ? 45_000 : 5_000 }).toBe(true);

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
      // Every real assertion for this page/mode has already run and passed above. This capture is
      // a best-effort visual-review artifact only — nothing reads it back, nothing asserts on it —
      // so it must never fail the test. At the two largest viewport x DPR combos (3840x2160,
      // 2560x1440 physical pixels) Chromium's headless screenshot protocol intermittently throws
      // "Protocol error (Page.captureScreenshot): Unable to capture screenshot" under CI's runner
      // memory ceiling (reproduces rarely locally too, confirming it's a Chromium/runner capture
      // flake, not an app or test-logic defect); jpeg (cheaper to encode than png) cut the failure
      // rate but didn't eliminate it, so the capture itself is wrapped rather than papering over a
      // real check.
      try {
        await page.screenshot({ path: `test-results/${pageSpec.id}-${mode}.jpg`, type: 'jpeg', quality: 80 });
      } catch (error) {
        console.warn(`screenshot capture failed for ${pageSpec.id} ${mode} (non-fatal, no assertion depends on it):`, error);
      }
    });
  }
}
