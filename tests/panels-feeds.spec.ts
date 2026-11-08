import { expect, test } from '@playwright/test';
import { Q } from '../site/lib/queries.js';
import { fixtureVlans, mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';

test('mc1 WAN and VLAN readouts render the fixture rates for every network', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises fixture-shaped metric responses only');
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator('#wan')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#wanrates')).toContainText('WAN 1');
  await expect(page.locator('#wanrates')).toContainText('WAN 2');
  await expect(page.locator('#wanrates')).toContainText('8.0');
  await expect(page.locator('#vlans')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#vlanrates div b')).toHaveText(fixtureVlans.map(({ network, vlan }) => `${network} · VLAN ${vlan}`));
});

test('mc1 topology labels measured devices, VLANs, and WAN rates', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises fixture-shaped MC1 network metrics only');
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');

  const labels = page.locator('#labels .vl');
  await expect(labels.filter({ hasText: 'GW-A' })).toContainText('64.0 Mbps');
  await expect(labels.filter({ hasText: 'SW-A' })).toContainText('24.0 Mbps');
  await expect(labels.filter({ hasText: 'AP-A' })).toContainText('12.0 Mbps');
  await expect(labels.filter({ hasText: 'NET-A' })).toContainText('NET-A · VLAN 10');
  await expect(labels.filter({ hasText: 'INTERNET' })).toContainText('RX 24.0 + TX 12.0 Mbps');
  await expect(labels).toHaveCount(12);
});

test.describe('mc1 firewall rows at a size that fits every fixture row', () => {
  // Shorter screens fold the last rows into "+N more"; this checks the rows themselves.
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('mc1 firewall columns render country drops, flow actions, and rule rates', async ({ page }) => {
    test.skip(!!wallUrl, 'exercises fixture-shaped firewall metric responses only');
    await mockFeeds(page);
    await page.goto('/mc1/?gl=2d');
    await expect(page.locator('#fw')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#fw .fwcol h3')).toHaveText(['Blocked at the edge', 'Live firewall · flows']);
    await expect(page.locator('#fwdrops .fwrow')).toHaveCount(5);
    await expect(page.locator('#fwdrops')).toContainText('events/min');
    await expect(page.locator('#fwflows .fwrow')).toHaveCount(7);
    await expect(page.locator('#fwflows')).toContainText('net-c → net-a · flow');
    await expect(page.locator('#fwflows')).toContainText('deny');
    await expect(page.locator('#fwflows')).toContainText('rule-a · rule');
  });
});

test('mc1 empty firewall metrics show no-feed and a failed query shows its message', async ({ page }) => {
  test.skip(!!wallUrl, 'forces empty and failed firewall metric responses');
  await mockFeeds(page, { emptyQuery: (q) => [Q.fwWanDrops, Q.fwFlowEvents, Q.fwRuleEvents].includes(q) });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator('#fw')).toHaveAttribute('data-state', 'no-feed');
  await expect.poll(() => page.locator('#fw').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"No feed"');

  await mockFeeds(page, { failQuery: (q) => q === Q.fwFlowEvents });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator('#fw')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#fw [data-panel-message]')).toHaveText('FIREWALL FLOW QUERY FAILED');
});

test('mc5 empty event and repository feeds render no invented events or releases', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises empty fixture-shaped GitHub responses only');
  await mockFeeds(page);
  await page.route('https://api.github.com/orgs/*/events', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.github.com/orgs/*/repos**', (route) => route.fulfill({ json: [] }));
  await page.goto('/mc5/');

  await expect(page.locator('#ticker')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#tickerBody .feed-row')).toHaveCount(1);
  await expect(page.locator('#tickerBody .feed-row .name')).toHaveText('—');
  await expect(page.locator('#releases')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#releasesBody .feed-row')).toHaveCount(1);
  await expect(page.locator('#releasesBody .feed-row .name')).toHaveText('—');
});

// The per-request readout replaced the queue/avg line, so each earlier expectation reads its new
// counterpart: queue "4.5s" -> the request-time line, avg "842ms" -> the decode slow tail and TTFT,
// model-coder "idle" -> model-mini's Idle (model-coder now serves requests), and the 203s average
// "3.4m" -> a long request time in whole seconds.
test('mc3 model tiles show per-request percentiles and read Idle when a model had no real request this hour', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped percentile response only');
  await mockFeeds(page);
  await page.goto('/mc3/');
  const tiles = page.locator('#modeltab .mc');
  const large = tiles.filter({ hasText: 'model-large' });
  // The engine's p50 decode speed is the large number; its slow tail is labelled as the slowest share.
  await expect(large.locator('.mctok')).toHaveText(/^104\s*tok\/s$/);
  await expect(large.locator('.mcstats')).toContainText('p50 1.8 s · p90 3.2 s · p99 5.6 s per request · 42 req/h');
  await expect(large.locator('.mcstats')).toContainText('decode p90 88 · p99 61 tok/s (slowest 10% / 1%)');
  await expect(large.locator('.mcstats')).toContainText('TTFT p50 0.31 s');
  // No engine row: the router's p50 request time is the large number.
  await expect(tiles.filter({ hasText: 'model-coder' }).locator('.mctok')).toHaveText(/^0\.62\s*s per request$/);
  // No real request this hour: Idle with the last request's age, never 0 tok/s.
  const mini = tiles.filter({ hasText: 'model-mini' });
  await expect(mini.locator('.mctok')).toHaveText('Idle');
  await expect(mini.locator('.mcstats')).toContainText('last request 3h 12m ago');
  // A long request time reads in whole seconds, never raw milliseconds.
  await expect(tiles.filter({ hasText: 'model-small' }).locator('.mcstats')).toContainText('p99 96 s');
});

test('mc1 empty storage, VLAN, and firewall queries show no metrics instead of totals', async ({ page }) => {
  test.skip(!!wallUrl, 'returns empty storage and VLAN metric responses from the fixture');
  await mockFeeds(page, {
    emptyQuery: (q) => [Q.fsSize, Q.fsAvail, Q.vlanRxBytes, Q.vlanTxBytes, Q.fwWanDrops, Q.fwFlowEvents, Q.fwRuleEvents].includes(q),
  });
  await page.goto('/mc1/?gl=2d');
  await expect(page.locator('#storage')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#strows')).toHaveText('—');
  await expect(page.locator('#vlans')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#vlanrates')).toHaveText('—');
  await expect(page.locator('#fw')).toHaveAttribute('data-state', 'no-feed');
});
