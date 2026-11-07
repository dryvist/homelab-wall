import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';

// D-mc1-2: a node that drops out of a single poll (a scrape gap, a restart) must keep its card
// with its last known values, marked stale. This test runs its own fixture
// (4 nodes, config-driven) rather than the
// shared 3-node one above, since that fixture's node count is load-bearing for unrelated
// assertions (D3's shared-mount row count).
test('a node missing from a later poll stays rendered, marked stale, with its last values', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture poll-drop sequence only');
  const nodeNames = ['node-a', 'node-b', 'node-c', 'node-d'];
  const dropped = 'node-a';
  const inst = (n: string) => ({ instance: `${n}:9100`, job: 'pve_node_exporter' });
  const vec = (rows: Array<[Record<string, string>, number]>) => rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));
  const cores = (n: string) => (n === dropped ? 80 : 16);

  let cpuPolls = 0;
  // A 1s refresh brings the second poll within a second. The page's setInterval does not wait for
  // a slow refresh, so a shorter one stacked overlapping refreshes on a loaded runner and the
  // dropped-node render arrived after the 5s assertion. The assertions below poll the route's own
  // call count and the DOM directly instead of a fixed wall-clock wait.
  await page.route('**/config.json', (r: Route) => r.fulfill({
    json: {
      title: 'HOMELAB', refreshSeconds: 1, guestCount: 4,
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

  await expect.poll(() => cpuPolls, { message: 'waiting for a second CPU poll to drop node-a' }).toBeGreaterThan(1);
  await expect(cards).toHaveCount(4); // still 4 cards — the node was never removed

  const staleCard = cards.filter({ hasText: dropped.toUpperCase() });
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
  const inst = (n: string) => ({ instance: `${n}:9100`, job: 'pve_node_exporter' });
  const vec = (rows: Array<[Record<string, string>, number]>) => rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));

  await page.route('**/config.json', (r: Route) => r.fulfill({
    json: {
      title: 'HOMELAB', refreshSeconds: 15, guestCount: 2,
      nodeRoles: { 'node-a': 'node-a', 'node-b': 'node-b' }, extraNodes: [],
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
        [{ ...inst('node-a'), device: 'rpool/ROOT/pve-1', mountpoint: '/', fstype: 'zfs' }, 2e12 * frac],
        [{ ...inst('node-b'), device: 'rpool/ROOT/pve-1', mountpoint: '/', fstype: 'zfs' }, 5e12 * frac],
        [{ ...inst('node-a'), device: 'shared-volume', mountpoint: '/mnt/shared', fstype: 'ext4' }, 3e12 * frac],
        [{ ...inst('node-b'), device: 'shared-volume', mountpoint: '/mnt/shared', fstype: 'ext4' }, 3e12 * frac],
      ];
      if (!queryExcludesNfs) {
        rows.push([{ ...inst('node-a'), device: 'node-b:/rpool/ROOT/pve-1', mountpoint: '/mnt/evac', fstype: 'nfs4' }, 5e12 * frac]);
      }
      return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: vec(rows) } } });
    }
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result: [] } } });
  });

  await page.goto('/mc1/?gl=2d');
  const rows = page.locator('#strows .st');
  // 3 rows: node-a's rpool, node-b's rpool (kept as two — same pool name, different nodes,
  // different sizes), and the one true shared device — never a 4th row for the NFS re-export.
  await expect(rows).toHaveCount(3);

  const labels = await rows.locator('span:first-child').allTextContents();
  expect(labels.map((l) => l.trim().toUpperCase().replace(/\s+/g, ' ')).sort()).toEqual(['NODE-A RPOOL', 'NODE-B RPOOL', 'SHARED SHARED']);

  // 2e12 (node-a rpool) + 5e12 (node-b rpool) + 3e12 (shared) = 10e12 bytes = 10.0 TB of unique
  // local storage — the NFS re-export of node-b's own pool never adds another 5e12 on top.
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
