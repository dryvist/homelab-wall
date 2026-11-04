import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import pendingJson from './expected-pending.json' with { type: 'json' };
import { config, mockFeeds, words } from './fixture';

// Record<string, string[]> keyed by page id (not just mc1's own keys) so a page id not yet in
// the fixture still typechecks — it simply has no allowed-pending panels.
const pending = pendingJson as { panels: Record<string, string[]>; queries: string[] };

const PAGES = [
  { id: 'mc1', path: '/mc1/' },
  { id: 'mc2', path: '/mc2/' },
  { id: 'mc3', path: '/mc3/' },
  { id: 'mc4', path: '/mc4/' },
  { id: 'mc5', path: '/mc5/' },
  { id: 'mc6', path: '/mc6/' },
] as const;
const MODES = ['2d', '3d'] as const;
const invalidMetric = /NaN|undefined|null|Infinity|—/;
// WALL_URL targets the live site instead of the fixture; skip the mock and its fixture-shaped assertions.
const wallUrl = process.env.WALL_URL;

for (const pageSpec of PAGES) {
  for (const mode of MODES) {
    test(`${pageSpec.id} ${mode} panels honor the data contract`, async ({ page }) => {
      // mc3's forced 3D core runs WebGPURenderer's WebGL2 backend on CI's software rasterizer,
      // where the first painted frame takes far longer than on the wall's GPU.
      const slowFirstFrame = pageSpec.id === 'mc3' && mode === '3d';
      if (slowFirstFrame) test.slow();
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
          await expect(panel).toHaveAttribute('data-state', 'pending');
          // A permanently-pending panel is marked data-source stand-in (invisible) and still has
          // real-looking content, never a blank panel — no visible marker distinguishes it. mc1's
          // "nodes" panel is the one exception: it's pending only while its GPU feed has no series,
          // and its node cards still show real data, so it stays data-source 'live'.
          if (!(pageSpec.id === 'mc1' && id === 'nodes')) {
            await expect(panel).toHaveAttribute('data-source', 'stand-in');
          }
          await expect.poll(() => panel.innerText()).not.toBe('');
        } else {
          await expect(panel).toHaveAttribute('data-state', 'ok');
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

// settle() (lib/prom.js) turns a rejected query into null, and mc1.js renders that as an
// explicit error panel — never as "0 OK / 54 NO DATA" (the bug the operator saw). Forces the
// score query to fail outright and asserts the panel says so.
test('a failed health query renders an explicit error, never a silent zero count or scary text', async ({ page }) => {
  test.skip(!!wallUrl, 'forces a query failure against the fixture server only');
  await mockFeeds(page, { failQuery: (q) => q.includes('gatus_results_total') && q.includes('by (name)') });
  await page.goto('/mc1/');
  const apps = page.locator('[data-panel="apps"]');
  // data-state stays the machine-readable 'error' signal, but nothing about it is visible: the
  // message is empty and the panel renders the shared sample scores instead of a blank/red panel.
  await expect(apps).toHaveAttribute('data-state', 'error');
  await expect(apps.locator('[data-panel-message]')).toHaveText('');
  await expect(apps).toHaveAttribute('data-source', 'stand-in');
  await expect(page.locator('#appsum')).toContainText(/\d/);
});

// A score query that succeeds with zero rows (never a failure — that's the error-state test
// above) is genuinely empty, so the apps panel falls back to the shared sample scores
// (site/lib/sampleData.js), marked only by the invisible data-source attribute — the wall never
// shows a visible "this is fake" badge.
test('a no-data apps panel renders sample scores marked only by data-source, never a live one', async ({ page }) => {
  test.skip(!!wallUrl, 'forces an empty score response against the fixture server only');
  await mockFeeds(page, { emptyQuery: (q) => q.includes('gatus_results_total') && q.includes('by (name)') });
  await page.goto('/mc1/');
  const apps = page.locator('[data-panel="apps"]');
  await expect(apps).toHaveAttribute('data-state', 'empty');
  await expect(apps).toHaveAttribute('data-source', 'stand-in');
  // The stand-in is real content, not just a marker: the panel's own summary reflects the sample
  // scores rather than sitting on an empty/placeholder summary.
  await expect(page.locator('#appsum')).toContainText(/\d/);

  await page.goto('/mc2/');
  await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-source', 'stand-in');
});

// Every panel with NO live source wired up at all (as opposed to a live query that returned zero
// rows this poll) shows stand-in content: no visible badge, no "pending" text — a machine-only
// data-source="stand-in" marker (site/lib/stage.js setStandIn) is the only trace, so the panel
// contract test above already covers its visible state (it must be 'ok', like a live panel).
// mc1's "nodes" panel is deliberately excluded: its node cards and GPU gauges are real data,
// never a stand-in.
const STAND_IN_PANELS: Record<string, string[]> = {
  mc1: ['firewall'], // mc1's topology panel is a MIX (real graph + a stand-in #wan sub-element)
  mc2: ['threat', 'blocked'],
  mc4: ['acquisition', 'pipeline'],
  mc5: ['infra'],
};

for (const [pageId, panelIds] of Object.entries(STAND_IN_PANELS)) {
  test(`${pageId}: every stand-in panel is marked machine-readably and never shows a visible badge or pending text`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
    await mockFeeds(page);
    await page.goto(`/${pageId}/`);
    for (const panelId of panelIds) {
      const panel = page.locator(`[data-panel="${panelId}"]`);
      await expect(panel, `${pageId} [data-panel="${panelId}"]`).toHaveAttribute('data-state', 'ok');
      await expect(panel, `${pageId} [data-panel="${panelId}"] data-source`).toHaveAttribute('data-source', 'stand-in');
      await expect(panel.locator('[data-sample-badge]'), `${pageId} [data-panel="${panelId}"] must have no visible badge`).toHaveCount(0);
      await expect(panel, `${pageId} [data-panel="${panelId}"] must have no pending text`).not.toContainText(/pending/i);
    }
    // mc1's "nodes" panel: real node and GPU data, never a stand-in.
    if (pageId === 'mc1') {
      await expect(page.locator('[data-panel="nodes"]')).not.toHaveAttribute('data-source', 'stand-in');
      // The topology panel itself stays 'ok'/un-flagged (it's a real graph); only its WAN
      // sub-element, which has no live exporter, carries the marker.
      await expect(page.locator('[data-panel="topology"]')).not.toHaveAttribute('data-source', 'stand-in');
      await expect(page.locator('#wan')).toHaveAttribute('data-source', 'stand-in');
    }
  });
}

// The VLAN panel (Q.vlanFwRate, apps PR #2214) is real once the fixture answers it: real values,
// no SAMPLE DATA badge. A separate assertion (not the generic contract loop) since it's a
// sub-element of the "topology" panel, not its own [data-panel].
test('mc1 VLAN readout shows real per-VLAN rates and drops the SAMPLE DATA badge once the query answers', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped VLAN response only');
  await mockFeeds(page);
  await page.goto('/mc1/');
  const vlans = page.locator('#vlans');
  await expect(vlans).toContainText('VLAN 10');
  await expect(vlans).toContainText('4.2');
  await expect(vlans.locator('[data-sample-badge]')).toHaveCount(0);
});

// mc1's GPU gauges (#g<i>3) are canvas pixels, so this records the value glyph each one last drew
// ('—' is the gauge's own no-data state); the returned reader lists them in node-card order.
async function recordGpuGlyphs(page: Page) {
  await page.addInitScript(() => {
    const glyphs: Record<string, string> = {};
    (window as unknown as { gpuGlyphs: Record<string, string> }).gpuGlyphs = glyphs;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, ...args: Parameters<CanvasRenderingContext2D['fillText']>) {
      const id = this.canvas.id, text = String(args[0]);
      if (/^g\d+3$/.test(id) && !text.startsWith('GPU')) glyphs[id] = text;
      fillText.apply(this, args);
    };
  });
  return () => page.evaluate(() => Object.values((window as unknown as { gpuGlyphs: Record<string, string> }).gpuGlyphs));
}

// Q.acceleratorBusy (site/lib/queries.js) carries no per-node label: every card's GPU gauge shows
// the busiest accelerator (the fixture's 64 over its 36) as a real reading, and the nodes panel is
// 'ok'. The old stand-in was a per-card sine wave, so four identical settled values rule it out.
test('mc1 GPU gauges show the busiest accelerator reading, never a stand-in', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped accelerator response only');
  const gpuGlyphs = await recordGpuGlyphs(page);
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator('[data-panel="nodes"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#nodelist .node')).toHaveCount(4);
  // Eased toward the reading like the cpu/mem/load gauges, so this waits for every card to settle.
  await expect.poll(gpuGlyphs, { timeout: 15_000 }).toEqual(['64', '64', '64', '64']);
  for (let i = 0; i < 4; i += 1) await expect(page.locator(`#g${i}3`)).not.toHaveAttribute('data-source', 'stand-in');
});

// No reading — an empty answer or a failed query — draws the gauge's no-data state with the nodes
// panel 'pending' (or 'error' for a failure), never a fabricated value.
for (const [outcome, state] of [['empty', 'pending'], ['failed', 'error']] as const) {
  test(`mc1 GPU gauges draw the no-data state when the accelerator query is ${outcome}`, async ({ page }) => {
    test.skip(!!wallUrl, 'forces the accelerator response against the fixture server only');
    const gpuGlyphs = await recordGpuGlyphs(page);
    const isGpu = (q: string) => q.includes('accelerator:busy_percent');
    await mockFeeds(page, outcome === 'empty' ? { emptyQuery: isGpu } : { failQuery: isGpu });
    await page.goto('/mc1/?gl=2d');
    // 'apps' leaves its initial 'pending' in the same render as 'nodes' — proof the first refresh landed.
    await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('[data-panel="nodes"]')).toHaveAttribute('data-state', state);
    await expect.poll(gpuGlyphs).toEqual(['—', '—', '—', '—']);
    for (let i = 0; i < 4; i += 1) await expect(page.locator(`#g${i}3`)).not.toHaveAttribute('data-source', 'stand-in');
  });
}

// A3: every panel meant to look live must visibly change within 10s even when the data source
// returns the exact same value on every poll (mockFeeds answers every refresh identically — a
// frozen-data fixture) or has no real source at all. site/lib/liveJitter.js's poissonLoop is what
// drives each of these instead of the panel sitting on the exact pixels/rows it painted at boot.
// Math.random is replaced with a seeded PRNG scaled to [0, 0.9). Poisson gaps are then at most
// -ln(0.1)/rate (~4.6 s for the 0.5/s block feed), so the 10 s bound always holds. Values still
// vary, so the jittered VLAN bars keep changing. A constant draw would freeze those bars.
test('mc1 VLAN pulse and flow rows keep changing within 10s on a frozen-data fixture', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
  await page.addInitScript(() => {
    let s = 1;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 0.9;
    };
  });
  await mockFeeds(page);
  await page.goto('/mc1/');

  const pulseFrame = () => page.locator('#vlanpulse').evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const before = await pulseFrame();
  await expect.poll(pulseFrame, { timeout: 10_000, message: '#vlanpulse canvas never redrew' }).not.toBe(before);

  const blkBefore = await page.locator('#blkrows').innerHTML();
  await expect.poll(() => page.locator('#blkrows').innerHTML(), { timeout: 10_000, message: '#blkrows never gained a new row' }).not.toBe(blkBefore);

  const fwBefore = await page.locator('#fwrows').innerHTML();
  await expect.poll(() => page.locator('#fwrows').innerHTML(), { timeout: 10_000, message: '#fwrows never gained a new row' }).not.toBe(fwBefore);
});

test('mc2 threat feed keeps firing rows within 10s on a frozen-data fixture', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
  await mockFeeds(page);
  await page.goto('/mc2/');
  const before = await page.locator('#feed').innerHTML();
  await expect.poll(() => page.locator('#feed').innerHTML(), { timeout: 10_000, message: '#feed never gained a new row' }).not.toBe(before);
});

// The request feed is real metadata rows (GET /api/llm/recent), so on a frozen feed it must
// stay stable: still data-feed="live", no new rows invented between polls — the fabricated
// Poisson rows the old stand-in feed produced are exactly what this now forbids.
test('mc3 request feed invents nothing on a frozen-data fixture and stays live', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
  await mockFeeds(page);
  await page.goto('/mc3/');
  await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'live');
  const before = await page.locator('#reqfeed').innerHTML();
  await page.waitForTimeout(6000);
  await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'live');
  expect(await page.locator('#reqfeed').innerHTML()).toBe(before);
});

test('mc4 throughput numerals keep changing within 10s on a frozen-data fixture', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
  await mockFeeds(page);
  await page.goto('/mc4/');
  const before = await page.locator('#acqbody').innerText();
  await expect.poll(() => page.locator('#acqbody').innerText(), { timeout: 10_000, message: '#acqbody never repainted' }).not.toBe(before);
});

// Q.llmQueueSeconds/Q.llmLatencySeconds (site/lib/queries.js) replaced a name-hash stand-in with
// real per-model averages. model-large's tile must show the fixture's real numbers with no
// stand-in marker; model-coder has no row in either query (no requests in the window — a real
// idle model, not a failed query) and must render the quiet "idle" state, never "—"/"N/A".
test('mc3 model tiles show real queue/avg values and render a quiet idle state when a model has none', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped queue/latency response only');
  await mockFeeds(page);
  await page.goto('/mc3/');
  const tiles = page.locator('#modeltab .mc');
  await expect(tiles.filter({ hasText: 'model-large' }).locator('.mcstats')).toContainText('4.5s');
  await expect(tiles.filter({ hasText: 'model-large' }).locator('.mcstats')).toContainText('842ms');
  await expect(tiles.filter({ hasText: 'model-large' }).locator('.mcstats')).not.toHaveAttribute('data-source', 'stand-in');
  await expect(tiles.filter({ hasText: 'model-coder' }).locator('.mcstats')).toContainText('idle');
  // model-mini's 203.361s average is the reported bug ("avg 203361ms") — must render as "3.4m",
  // never raw milliseconds. Covers all three human-duration ranges together with the two above:
  // sub-second ("842ms"), sub-minute ("4.5s"), and minutes-and-up ("3.4m").
  await expect(tiles.filter({ hasText: 'model-mini' }).locator('.mcstats')).toContainText('3.4m');
});

test('the SAMPLE DATA badge never appears on a panel that has real data', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok');
  // Scoped to the panels that CAN have live data (topology/firewall carry stand-in content on this
  // page regardless of the fixture and are covered by the dedicated test above).
  const liveCapable = page.locator('[data-panel="nodes"], [data-panel="apps"], [data-panel="storage"], [data-panel="llm"]');
  const count = await liveCapable.count();
  for (let i = 0; i < count; i += 1) {
    await expect(liveCapable.nth(i)).not.toHaveAttribute('data-source', 'stand-in');
  }
});

// No visible non-production marker survives anywhere on any page: no "N/A"/"SAMPLE DATA"/
// "PENDING"/"NO DATA"/"FAILED" text and no em-dash placeholder, regardless of panel state.
const NON_PROD_TEXT = /\bN\/A\b|SAMPLE DATA|PENDING|NO DATA|NO GPU\b|FAILED|—/;
for (const pageSpec of PAGES) {
  test(`${pageSpec.id}: no visible non-production text anywhere on the page`, async ({ page }) => {
    if (!wallUrl) await mockFeeds(page);
    await page.goto(pageSpec.path);
    await expect.poll(() => page.locator('body').innerText()).not.toMatch(NON_PROD_TEXT);
  });
}

// Same assertion, but with the gateway itself failing every query outright (hard errors, not
// just empty results) and with real data thinned to a partial set (some apps/models scored,
// others not — never a whole-panel wipe) — the scenario a healthy-looking wall at scale
// (many services, many models) actually hits: individual gaps in otherwise-real data, and
// outright query failures, must fall back to a stand-in value, never a visible placeholder.
for (const pageSpec of PAGES) {
  test(`${pageSpec.id}: no visible non-production text with the gateway returning nulls/errors`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped assertions only');
    await mockFeeds(page, {
      failQuery: (q) => /litellm_total_tokens_metric_total|litellm_proxy_total_requests_metric_total|success="true"/.test(q),
      emptyQuery: (q) => /filesystem_size|unifi_vlan_fw_events_total/.test(q),
    });
    await page.goto(pageSpec.path);
    await expect.poll(() => page.locator('body').innerText()).not.toMatch(NON_PROD_TEXT);
  });
}

// D-mc1-2: a node that drops out of a single poll (a scrape gap, a restart) must keep its card
// with its last known values, marked stale — never disappear. The operator's report was exactly
// this: a real 4th PVE node (80 cores, like pve-r540) vanished from the panel entirely during a
// transient metrics gap. This test runs its own fixture (4 nodes, config-driven) rather than the
// shared 3-node one above, since that fixture's node count is load-bearing for unrelated
// assertions (D3's shared-mount row count).
test('a node missing from a later poll stays rendered, marked stale, with its last values', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture poll-drop sequence only');
  const nodeNames = ['pve-r540', 'pve-r710', 'pve-w1700', 'pve-w5900'];
  const dropped = 'pve-r540';
  const inst = (n: string) => ({ instance: `${n}.example.test:9100`, job: 'pve_node_exporter' });
  const vec = (rows: Array<[Record<string, string>, number]>) => rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));
  const cores = (n: string) => (n === dropped ? 80 : 16);

  let cpuPolls = 0;
  // refreshSeconds is as short as the page allows, and the assertions below poll the route's
  // own call count / the DOM directly instead of a fixed wall-clock wait, so this test holds
  // its page (and its 30fps WebGL/canvas draw loop) busy for as little real CI time as
  // possible — it runs alongside other projects' pages on a shared CI runner, and a long fixed
  // wait here previously starved an unrelated webkit test's own 5s poll deadline.
  await page.route('**/config.json', (r: Route) => r.fulfill({
    json: {
      title: 'HOMELAB', refreshSeconds: 0.2, guestCount: 4,
      nodeRoles: Object.fromEntries(nodeNames.map((n) => [n, n])), extraNodes: [],
      groups: [{ name: 'apps', apps: ['alpha'] }],
    },
  }));
  await page.route('**/api/prom/**', (r: Route) => {
    const url = new URL(r.request().url());
    const q = url.searchParams.get('query') || '';
    let live = nodeNames;
    if (url.pathname.endsWith('/query') && q.includes('mode="idle"') && !q.startsWith('count')) {
      cpuPolls += 1;
      if (cpuPolls > 1) live = nodeNames.filter((n) => n !== dropped);
    }
    const rows = q.includes('mode="idle"') && q.startsWith('count') ? vec(nodeNames.map((n) => [inst(n), cores(n)]))
      : q.includes('mode="idle"') ? vec(live.map((n) => [inst(n), 30]))
      : q.includes('MemAvailable') || q.includes('MemTotal') || q.includes('node_load1') || q.includes('hwmon') || q.includes('boot_time') ? vec(nodeNames.map((n) => [inst(n), 1]))
      : [];
    const result = url.pathname.endsWith('query_range') ? rows.map((x) => ({ metric: x.metric, values: [[0, '10']] })) : rows;
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result } } });
  });

  // ?gl=2d skips the WebGL topology renderer this test doesn't need — plain canvas draws are
  // cheaper, cutting further into this test's CI CPU footprint.
  await page.goto('/mc1/?gl=2d');
  const cards = page.locator('#nodelist .node');
  await expect(cards).toHaveCount(4);

  await expect.poll(() => cpuPolls, { message: 'waiting for a second CPU poll to drop pve-r540' }).toBeGreaterThan(1);
  await expect(cards).toHaveCount(4); // still 4 cards — the node was never removed

  // nodeRoles preserves insertion order, so #node0 is pve-r540 (the dropped one).
  const staleCard = page.locator('#node0');
  await expect(staleCard).toHaveClass(/stale/);
  // "STALE <age>" only ever renders from a held-over lastGood entry (mc1.js drawNodes) — it
  // could not appear unless the node's earlier good reading was kept and reused.
  await expect(staleCard.locator('.nm em')).toContainText('STALE');
});

// D-mc1-3: the storage panel double-counted capacity two ways — (1) a network mount of another
// node's own pool (an NFS re-export) reported the same bytes under a different device and
// mountpoint, counted again on top of the origin; (2) the ZFS dedup key was the pool name alone
// ("zfs:rpool"), so every host's own distinctly-sized "rpool" collided into a single kept row,
// silently dropping the others' capacity. This mock stands in for Prometheus itself: it only
// omits the NFS row once the outgoing PromQL query text actually asks it to (queries.js's FS
// filter), so the test fails against the pre-fix query (no fstype exclusion, NFS row included)
// and passes once queries.js excludes network filesystems natively.
test('storage panel excludes network mounts and keys ZFS pools per host', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture NFS/ZFS-collision fixture only');
  const inst = (n: string) => ({ instance: `${n}.example.test:9100`, job: 'pve_node_exporter' });
  const vec = (rows: Array<[Record<string, string>, number]>) => rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));

  await page.route('**/config.json', (r: Route) => r.fulfill({
    json: {
      title: 'HOMELAB', refreshSeconds: 15, guestCount: 2,
      nodeRoles: { 'host-a': 'host-a', 'host-b': 'host-b' }, extraNodes: [],
      groups: [{ name: 'apps', apps: ['alpha'] }],
    },
  }));
  await page.route('**/api/prom/**', (r: Route) => {
    const url = new URL(r.request().url());
    const q = url.searchParams.get('query') || '';
    if (q.includes('gatus_results_total')) return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: [] } } });
    if (q.includes('filesystem_size') || q.includes('filesystem_avail')) {
      const frac = q.includes('filesystem_avail') ? 0.5 : 1; // avail = half of size, for a stable used%
      // Simulates the real Prometheus filter: an NFS row is only withheld when the query text
      // itself asks to exclude it, the same way a real server would honor the PromQL filter.
      const queryExcludesNfs = /nfs/i.test(q) && q.includes('fstype');
      const rows: Array<[Record<string, string>, number]> = [
        [{ ...inst('host-a'), device: 'rpool/ROOT/pve-1', mountpoint: '/', fstype: 'zfs' }, 2e12 * frac],
        [{ ...inst('host-b'), device: 'rpool/ROOT/pve-1', mountpoint: '/', fstype: 'zfs' }, 5e12 * frac],
        [{ ...inst('host-a'), device: 'shared:/vol', mountpoint: '/mnt/shared', fstype: 'ext4' }, 3e12 * frac],
        [{ ...inst('host-b'), device: 'shared:/vol', mountpoint: '/mnt/shared', fstype: 'ext4' }, 3e12 * frac],
      ];
      if (!queryExcludesNfs) {
        rows.push([{ ...inst('host-a'), device: 'host-b.example.test:/rpool/ROOT/pve-1', mountpoint: '/mnt/pve/evac', fstype: 'nfs4' }, 5e12 * frac]);
      }
      return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: vec(rows) } } });
    }
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: [] } } });
  });

  await page.goto('/mc1/?gl=2d');
  const rows = page.locator('#strows .st');
  // 3 rows: host-a's rpool, host-b's rpool (kept as two — same pool name, different hosts,
  // different sizes), and the one true shared device — never a 4th row for the NFS re-export.
  await expect(rows).toHaveCount(3);

  const labels = await rows.locator('span:first-child').allTextContents();
  expect(labels.map((l) => l.trim().toUpperCase().replace(/\s+/g, ' ')).sort()).toEqual(['HOST-A RPOOL', 'HOST-B RPOOL', 'SHARED SHARED']);

  // 2e12 (host-a rpool) + 5e12 (host-b rpool) + 3e12 (shared) = 10e12 bytes = 10.0 TB of unique
  // local storage — the NFS re-export of host-b's own pool never adds another 5e12 on top.
  await expect(page.locator('#sttot')).toContainText('10.0 TB');
});

// A1: an app with no real score (D5's 'juliet', already unscored in the default fixture —
// see fixture.ts's gatus_results_total filter) must never draw "?" on the service-health hex
// grid (mc1 #hex) or app grid (mc5 #appgrid) — it renders as a red 0, same as any other 0 score.
// The glyph itself is canvas pixels, unreadable from the DOM, so this checks the machine-only
// data-unknown-count hook (set alongside the glyph, from the same apps[].s the glyph reads) is
// actually exercised by the fixture, and scans the whole page for a literal "?" regardless.
for (const pageId of ['mc1', 'mc5'] as const) {
  test(`${pageId}: an app with no real score draws as a red 0, never "?"`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture partial-score scenario only');
    await mockFeeds(page);
    await page.goto(`/${pageId}/`);
    const canvasId = pageId === 'mc1' ? '#hex' : '#appgrid';
    await expect.poll(() => page.locator(canvasId).getAttribute('data-unknown-count')).not.toBeNull();
    const unknownCount = Number(await page.locator(canvasId).getAttribute('data-unknown-count'));
    expect(unknownCount, 'fixture must include at least one app with no real score (D5)').toBeGreaterThan(0);
    await expect.poll(() => page.locator('body').innerText()).not.toContain('?');
  });
}

// A2: site/lib/hexlayout.js is the ONE grouping helper shared by mc1 and mc5 — plain data in,
// plain data out, so this imports it directly rather than driving a browser page.
test('hexlayout: leaves exactly one gap cell between every pair of non-empty groups, ordered by config.groups', async () => {
  const { groupedHexLayout } = await import('../site/lib/hexlayout.js');
  const groups = [
    { name: 'a', apps: ['one', 'two'] },
    { name: 'b', apps: ['two', 'three'] }, // 'two' is already in group a — stays with the first group
    { name: 'c', apps: [] }, // an empty group contributes no cells and no extra gap
    { name: 'd', apps: ['four'] },
  ];
  const layout = groupedHexLayout(groups);
  expect(layout).toEqual(['one', 'two', null, 'three', null, 'four']);
  // Exactly one null between every pair of consecutive non-null runs — never zero, never two.
  const gapIndexes = layout.flatMap((cell, i) => (cell === null ? [i] : []));
  expect(gapIndexes).toEqual([2, 4]);
});

// mc5's GitOps hero (site/mc5/mc5.js): the full-viewport #corecanvas scene and the org-activity
// ticker are both fed by the fixture's mocked GitHub events/repos (tests/fixture.ts mockGithub) —
// this asserts the hero actually renders pixels and the ticker actually shows rows, on top of the
// generic per-page contract test above (which already covers every canvas/panel more broadly).
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
// go, but a source absent from this poll renders an explicit NO FEED tile — never omitted,
// never filled with stand-in words. The fixture answers five sources (user, claude, codex,
// zcode and the never-heard-of 'minion'), so gemini, antigravity and opencode show NO FEED.
test('mc6 renders a tile for every known source, NO FEED where the feed has no rows', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped words response only');
  await mockFeeds(page);
  await page.goto('/mc6/');
  const panel = page.locator('[data-panel="lexicon"]');
  await expect(panel).toHaveAttribute('data-state', 'ok');

  const tiles = page.locator('#strip .tile');
  await expect(tiles).toHaveCount(8); // 7 known sources + the fixture's unknown 'minion'
  for (const [source, label] of [
    ['user', 'OPERATOR'], ['claude', 'CLAUDE'], ['codex', 'CODEX'], ['gemini', 'GEMINI'],
    ['antigravity', 'AGY'], ['zcode', 'ZCODE'], ['opencode', 'OPENCODE'], ['minion', 'MINION'],
  ] as const) {
    const tile = page.locator(`#strip .tile[data-word-source="${source}"]`);
    await expect(tile.locator('.tlabel')).toHaveText(label);
    if (['gemini', 'antigravity', 'opencode'].includes(source)) {
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
  let wordsCalls = 0;
  await page.route('**/api/words', (r: Route) => {
    wordsCalls += 1;
    if (wordsCalls === 1) return r.fulfill({ json: { meta: [], data: words, rows: words.length } });
    return r.fulfill({ status: 500, json: { error: 'forced failure' } });
  });
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  await expect.poll(() => wordsCalls, { message: 'waiting for a second words poll to fail' }).toBeGreaterThan(1);

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
  await expect(tiles).toHaveCount(7);
  await expect(page.locator('#strip .tile .tfeed')).toHaveCount(7);
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

// The hero canvas holds a faint radial haze (alpha 0.1 at most) under the words, which are drawn
// at alpha 0.8 or more. Counting pixels above alpha 128 therefore counts word pixels only, and
// their mean position says where on the canvas the words were drawn (0..1 on each axis).
async function heroWordPixels(page: Page) {
  return page.locator('#cloudhero').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const { width, height } = canvas;
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 128) {
          count += 1;
          sumX += x;
          sumY += y;
        }
      }
    }
    return { count, cx: count ? sumX / count / width : 0, cy: count ? sumY / count / height : 0 };
  });
}

// One source with forty words, so the hero cloud is a blob around the middle of its box.
const heroWords = Array.from({ length: 40 }, (_, i) => ({ source: 'user', word: `term${i}`, n: String(400 - i * 9) }));

// d3-cloud places words around 0,0, so the hero only shows its cloud on the canvas when it draws
// from the canvas midpoint: the drawn words must sit around the middle, not the top-left corner.
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
