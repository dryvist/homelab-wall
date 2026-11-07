import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockFeeds } from './fixture';
import { PAGES, wallUrl } from './panels-contract';

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
