import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Q } from '../site/lib/queries.js';
import { config, mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';

// MC1's LLM list holds only models with a real request in the last 4d (Q.llmUsed4d), in MC1's existing
// order, and its summary counts only those. model-unused is deployed but served only the health check.
test('mc1 LLM list shows only recently used models and its summary counts only those', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped model list only');
  await mockFeeds(page);
  await page.goto('/mc1/?gl=2d');
  const llm = page.locator('[data-panel="llm"]');
  await expect(llm).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#llmrows .lr > span:first-of-type')).toHaveText(['model-small', 'model-coder', 'model-large', 'model-mini']);
  await expect(page.locator('#llmrows')).not.toContainText('model-unused');
  await expect(page.locator('#llmsum')).toContainText('3/4 UP');
});

// A failed Q.llmUsed4d lists every deployment as before, with the panel's error marker, never an empty list.
test('mc1 a failed used-models query lists every deployment and marks the LLM panel', async ({ page }) => {
  test.skip(!!wallUrl, 'forces a query failure against the fixture server only');
  await mockFeeds(page, { failQuery: (q) => q === Q.llmUsed4d });
  await page.goto('/mc1/?gl=2d');
  const llm = page.locator('[data-panel="llm"]');
  await expect(llm).toHaveAttribute('data-state', 'error');
  await expect(llm.locator('[data-panel-message]')).toHaveText('');
  await expect(page.locator('#llmrows .lr')).toHaveCount(5);
  await expect(page.locator('#llmrows')).toContainText('model-unused');
  await expect(page.locator('#llmsum')).toContainText('4/5 UP');
});

for (const pageId of ['mc1', 'mc2', 'mc4', 'mc5']) {
  test(`${pageId} failed score queries show the error state without app values`, async ({ page }) => {
    test.skip(!!wallUrl, 'forces a score query failure against the fixture server only');
    await mockFeeds(page, { failQuery: (q) => q === Q.appScore });
    await page.goto(`/${pageId}/`);
    const apps = page.locator('[data-panel="apps"]');
    await expect(apps).toHaveAttribute('data-state', 'error');
    await expect(apps.locator('[data-panel-message]')).toHaveText('SCORE QUERY FAILED');
    await expect(page.locator('#appsum')).toHaveText('—');
  });

  test(`${pageId} empty score queries keep the app summary empty`, async ({ page }) => {
    test.skip(!!wallUrl, 'returns an empty score response from the fixture server');
    await mockFeeds(page, { emptyQuery: (q) => q === Q.appScore });
    await page.goto(`/${pageId}/`);
    await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'empty');
    await expect(page.locator('#appsum')).toHaveText('—');
    if (pageId === 'mc1') {
      for (const group of config.groups) {
        const label = page.locator('#labels .vl').filter({ hasText: group.name.toUpperCase() });
        await expect(label).toContainText(`${group.apps.length} apps · health — · ${group.apps.length} no data`);
      }
    }
  });
}

for (const pageId of ['mc2', 'mc4', 'mc5']) {
  test(`${pageId} held scores stay visible as stale during a failure and recover`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises changing score responses against the fixture server only');
    await mockFeeds(page);
    await page.route('**/config.json', (route) => route.fulfill({ json: { ...config, refreshSeconds: 1 } }));
    let phase: 'live' | 'failing' | 'recovered' = 'live';
    await page.route('**/api/prom/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('query') !== Q.appScore) return route.fallback();
      if (phase === 'failing') return route.fulfill({ status: 500, json: { status: 'error', error: 'forced failure' } });
      if (phase === 'recovered') {
        const result = config.groups.flatMap((group) => group.apps).map((name) => ({
          metric: { name }, value: [Date.now() / 1000, '0'],
        }));
        return route.fulfill({ json: { status: 'success', data: { resultType: 'vector', result } } });
      }
      return route.fallback();
    });

    await page.goto(`/${pageId}/`);
    const apps = page.locator('[data-panel="apps"]');
    await expect(apps).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#appsum')).not.toContainText(/\b0 OK\b/);
    phase = 'failing';
    await expect(apps).toHaveAttribute('data-state', 'stale');
    await expect(page.locator('#appsum')).not.toContainText(/\b0 OK\b/);
    phase = 'recovered';
    await expect(apps).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#appsum')).toContainText(/\b0 OK\b/);
  });
}

const MC4_QBIT_QUERIES = [
  Q.mc4QbitDownloadRate, Q.mc4QbitUploadRate, Q.mc4QbitDhtNodes, Q.mc4QbitConnection,
  Q.mc4TorrentProgress, Q.mc4TorrentShareRatio,
];

test('mc4 live media panels render fixture telemetry and each panel has its own live state', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped media telemetry only');
  await mockFeeds(page);
  await page.goto('/mc4/?gl=2d');

  for (const id of ['qbit', 'library', 'plex', 'torrents', 'arr', 'vpn', 'recently-added']) {
    const panel = page.locator(`[data-panel="${id}"]`);
    await expect(panel, `${id} panel`).toHaveAttribute('data-state', 'ok');
  }
  await expect(page.locator('#qbit')).toContainText('5.0 MiB/s');
  await expect(page.locator('#qbit')).toContainText('432');
  await expect(page.locator('#qbit')).toContainText('average share ratio');
  await expect(page.locator('#qbit')).not.toContainText('peers');
  await expect(page.locator('#torrents .trow')).toHaveCount(5);
  await expect(page.locator('#torrents')).toContainText('+13 more');
  await expect(page.locator('#torrents')).toContainText('The Life and Passion of Jesus Christ (1903)');
  await expect(page.locator('#library')).toContainText('31.0 TiB');
  await expect(page.locator('#library')).toContainText('Other');
  await expect(page.locator('#library')).not.toContainText('Music');
  await expect(page.locator('#plex')).toContainText('active sessions');
  await expect(page.locator('#plex')).toContainText('transcodes');
  await expect(page.locator('#plex')).toContainText('transcode');
  await expect(page.locator('#plex')).not.toContainText('Mb/s');
  await expect(page.locator('#arr .aname')).toHaveText(['sonarr', 'radarr', 'prowlarr', 'seerr', 'qbittorrent', 'plex']);
  await expect(page.locator('#vpn')).toContainText('CONNECTED');
  await expect(page.locator('#vpnDetail')).toContainText('42s ago');
  await expect(page.locator('#vpnDetail')).not.toContainText('leak');
  await expect(page.locator('#posters .poster')).toHaveCount(8);
  await expect(page.locator('#posters')).toContainText('ago');
});

test('mc4 a failed first QBITTORRENT feed shows error without blanking other cards', async ({ page }) => {
  test.skip(!!wallUrl, 'forces a media query failure against the fixture server only');
  await mockFeeds(page, { failQuery: (query) => MC4_QBIT_QUERIES.some((expression) => expression === query) });
  await page.goto('/mc4/?gl=2d');
  await expect(page.locator('#qbit')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#qbit')).toContainText('ERROR');
  await expect(page.locator('#library')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#library')).toContainText('31.0 TiB');
});

test('mc4 a successful empty QBITTORRENT feed shows empty', async ({ page }) => {
  test.skip(!!wallUrl, 'forces empty media responses against the fixture server only');
  await mockFeeds(page, { emptyQuery: (query) => MC4_QBIT_QUERIES.some((expression) => expression === query) });
  await page.goto('/mc4/?gl=2d');
  await expect(page.locator('#qbit')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#qbit')).toContainText('NO FEED');
});

test('mc4 held QBITTORRENT readings become stale when their queries fail', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises changing media responses against the fixture server only');
  await mockFeeds(page);
  await page.route('**/config.json', (route) => route.fulfill({ json: { ...config, refreshSeconds: 1 } }));
  let failing = false;
  await page.route('**/api/prom/**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('query') || '';
    if (failing && MC4_QBIT_QUERIES.some((expression) => expression === query)) {
      return route.fulfill({ status: 500, json: { status: 'error', error: 'forced failure' } });
    }
    return route.fallback();
  });

  await page.goto('/mc4/?gl=2d');
  const qbit = page.locator('#qbit');
  await expect(qbit).toHaveAttribute('data-state', 'ok');
  failing = true;
  await expect(qbit).toHaveAttribute('data-state', 'stale');
  await expect(qbit).toContainText('STALE');
  await expect(qbit).toContainText('5.0 MiB/s');
  await expect(page.locator('#library')).toHaveAttribute('data-state', 'ok');
});
