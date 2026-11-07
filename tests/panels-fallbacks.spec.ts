import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';

// settle() turns a rejected query into null, rendered as an
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
