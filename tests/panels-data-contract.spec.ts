import { expect, test } from '@playwright/test';
import { config, mockFeeds } from './fixture';
import { PAGES, MODES, pending, invalidMetric, wallUrl } from './panels-contract';

const noFeedPanels: Record<string, string[]> = {
  mc1: [],
  mc5: ['infra'],
};

for (const pageSpec of PAGES) {
  for (const mode of MODES) {
    test(`${pageSpec.id} ${mode} panels honor the data contract`, async ({ page }) => {
      // A forced 3D page runs WebGL2 on CI's software rasterizer, where the first painted frame, and the
      // first poll's render behind it, take far longer than on the wall's GPU; mc3's core is the slowest.
      const slowFirstFrame = mode === '3d' && !wallUrl;
      if (slowFirstFrame) test.slow();
      const firstState = slowFirstFrame ? { timeout: 15_000 } : {};
      const faults: string[] = [];
      page.on('pageerror', (error) => faults.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') faults.push(message.text());
      });
      page.on('requestfailed', (request) => faults.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
      page.on('response', (response) => {
        if (response.status() >= 400) faults.push(`${response.status()} ${response.url()}`);
      });

      if (!wallUrl) {
        await mockFeeds(page);
        // A transient failed first poll recovers on the next one, as on the wall; poll often enough
        // that the next one lands inside the first-state wait.
        await page.route('**/config.json', (r) => r.fulfill({ json: { ...config, refreshSeconds: 4 } }));
      }
      await page.goto(`${pageSpec.path}?gl=${mode}`);
      const panels = page.locator('[data-panel]');
      await expect(panels).not.toHaveCount(0);

      // Every panel is 'ok', except declared pending panels and panels with no feed at all.
      const allowed = new Set(pending.panels[pageSpec.id] ?? []);
      const noFeed = new Set(noFeedPanels[pageSpec.id] ?? []);
      const count = await panels.count();
      for (let index = 0; index < count; index += 1) {
        const panel = panels.nth(index);
        const id = await panel.getAttribute('data-panel');
        expect(id).not.toBeNull();
        if (wallUrl && pageSpec.id === 'mc1' && id === 'firewall') {
          await expect(panel).toHaveAttribute('data-state', /^(ok|no-feed)$/);
          continue;
        }
        if (noFeed.has(id!)) {
          await expect(panel).toHaveAttribute('data-state', 'no-feed');
          await expect.poll(() => panel.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"No feed"');
          continue;
        }
        // Web-first assertion: the state is set once the panel's feed resolves, not on insert.
        if (allowed.has(id!)) {
          await expect(panel).toHaveAttribute('data-state', 'pending', firstState);
          await expect.poll(() => panel.innerText()).not.toBe('');
        } else {
          await expect(panel, `request faults: ${faults.join(' | ') || 'none'}`).toHaveAttribute('data-state', 'ok', firstState);
          // Poll, not a one-shot read: a panel can flip to data-state="ok" (set synchronously
          // by renderStatic) a frame before its own rAF-scheduled repaint (e.g. mc1's #appsum)
          // has actually painted over its placeholder "—". On a slow 3D first frame that repaint waits as long as the state.
          await expect.poll(() => panel.innerText(), firstState).not.toMatch(invalidMetric);
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

      // Lists the blank canvases, so a failure names them.
      await expect.poll(() => page.locator('canvas').evaluateAll((canvases) => Array.from(canvases)
        .filter((canvas) => !(canvas instanceof HTMLCanvasElement && canvas.toDataURL().length > 200))
        .map((canvas) => canvas.id || canvas.className || 'canvas')), slowFirstFrame ? { timeout: 45_000 } : {}).toEqual([]);

      const overlaps = await panels.evaluateAll((elements) => {
        const box = (element: HTMLElement) => {
          let left = 0, top = 0;
          let current: HTMLElement | null = element;
          while (current) {
            left += current.offsetLeft;
            top += current.offsetTop;
            current = current.offsetParent as HTMLElement | null;
          }
          return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight };
        };
        return (elements as HTMLElement[]).flatMap((element, index) => {
        const a = box(element);
        return (elements as HTMLElement[]).slice(index + 1).flatMap((other) => {
          const b = box(other);
          return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
            ? [[element.getAttribute('data-panel'), other.getAttribute('data-panel')]]
            : [];
        });
        });
      });
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
