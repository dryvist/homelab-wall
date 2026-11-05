import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mockFeeds, recentRows, type FeedOpts } from './fixture';

// mc3-specific contract: the request feed is real metadata rows from GET /api/llm/recent (never
// message content, never fabricated rows), the GPU tile reads Q.acceleratorBusy, and the hero
// reactor proves itself on both render paths (?gl=2d and the default WebGPU/TSL one) with the
// same ready-message handshake the rotator (site/rotator/rotator.js) depends on.
const wallUrl = process.env.WALL_URL;

function watchFaults(page: Page) {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(message.text());
  });
  page.on('requestfailed', (request) => faults.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
  page.on('response', (response) => {
    if (response.status() >= 400) faults.push(`${response.status()} ${response.url()}`);
  });
  return faults;
}

// Readiness gates. The page writes its refresh state (anchor counts, labels) in render(), which also marks the
// scene signal pending. The next drawn frame, in either renderer, takes the new inputs in and sets
// data-scene="ready"; data-renderer names the path that drew it. A build or a first frame can take many seconds
// on a loaded runner, so every test waits for these signals here, with one bound, and then asserts with the
// default timeout.
const READY_TIMEOUT = 60_000;
async function awaitReady(page: Page, mode: '2d' | '3d') {
  await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok', { timeout: READY_TIMEOUT });
  await expect(page.locator('#reactor')).toHaveAttribute('data-renderer', mode, { timeout: READY_TIMEOUT });
  await expect(page.locator('#reactor')).toHaveAttribute('data-scene', 'ready', { timeout: READY_TIMEOUT });
}

for (const mode of ['2d', '3d'] as const) {
  test(`mc3 ${mode}: ready message, live feed rows, and no console errors`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    // Registered before any page script runs: signalReady fires after the very first rendered
    // frame, which can beat a listener installed after goto(). In the page's own window the
    // parent is the window itself, so the rotator's {wall:'ready'} post arrives with
    // e.source === window — exactly the handshake site/rotator/rotator.js listens for.
    await page.addInitScript(() => {
      (window as { wallReady?: number }).wallReady = 0;
      window.addEventListener('message', (e: MessageEvent) => {
        if (e.source === window && (e.data as { wall?: string })?.wall === 'ready') (window as { wallReady?: number }).wallReady! += 1;
      });
    });
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    // stage.js signalReady is once-guarded, so exactly one ready per load — the rotator contract.
    // Forced 3D on CI runs WebGPURenderer's WebGL2 backend on a software rasterizer, where the
    // first frame (shader builds plus the particle init dispatch) takes far longer than on the
    // wall's GPU. The 2D wait allows a cold first page load on a shared CI runner; the rotator
    // itself still accepts a late 'ready' (site/rotator/rotator.js).
    await expect.poll(() => page.evaluate(() => (window as { wallReady?: number }).wallReady), { timeout: mode === '3d' ? 45_000 : 15_000 }).toBe(1);

    await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'live');
    await expect(page.locator('#reqfeed .cfrow')).toHaveCount(recentRows.length);
    await expect(page.locator('#reqfeed')).toContainText('claude · model-coder');
    await expect(page.locator('#reqfeed')).toContainText('2.5k ch');
    await expect(page.locator('#reqfeed')).not.toContainText('tok');

    // The GPU tile shows the fixture's accelerator:busy_percent:avg5m mean (36/64/20 -> 40%), not a
    // stand-in derivation, and carries no stand-in marker.
    await expect(page.locator('#cxGpu')).toHaveText('40%');
    await expect(page.locator('#cxGpu')).not.toHaveAttribute('data-source', 'stand-in');

    expect(faults).toEqual([]);
  });
}

// The newest row arriving on a later poll must land in the feed and fire a comet from its core
// (the comet itself is GPU-side; this asserts the CPU handoff mc3.js owns: feedSeen diffing).
test('mc3: a new /api/llm/recent row prepends to the feed within one poll', async ({ page }) => {
  test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
  const faults = watchFaults(page);
  let served = 0;
  const later = [...recentRows, { ts: '2026-01-01 00:00:10', source: 'gemini', model: 'model-mini', role: 'user', chars: 64 }];
  await mockFeeds(page, { recent: () => (served++ === 0 ? recentRows : later) });
  await page.goto('/mc3/?gl=2d');
  await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'live');
  await expect(page.locator('#reqfeed')).toContainText('model-large');
  const first = () => page.locator('#reqfeed .cfrow').first().innerText();
  await expect.poll(first, { timeout: 10_000, message: 'the newest row never reached the feed' }).toContain('gemini');
  expect(faults).toEqual([]);
});

// No gateway route (the static fixture / a gateway without the ClickHouse feed): an explicit
// no-feed state, never fabricated rows, never a console error storm.
test('mc3: a missing /api/llm/recent renders an explicit NO FEED state with no invented rows', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the no-feed state against the fixture server only');
  const faults = watchFaults(page);
  await mockFeeds(page, { failQuery: (q) => q === '/api/llm/recent', emptyQuery: (q) => q.includes('accelerator:busy_percent') });
  await page.goto('/mc3/?gl=2d');
  await expect(page.locator('#reqfeed')).toHaveAttribute('data-feed', 'none');
  await expect(page.locator('#reqfeed')).toContainText('NO FEED');
  await expect(page.locator('#reqfeed .cfrow')).toHaveCount(1);
  // The GPU query succeeds with no series here: the tile is explicit, not 0%.
  await expect(page.locator('#cxGpu')).toHaveText('NO FEED');
  // The 404 itself is the feed being absent — pollFeed turns it into the state above; nothing
  // else may fault (no pageerror, no other request failure).
  // Chromium also logs the 404 as a generic console resource error.
  expect(faults.filter((f) => !(f.startsWith('404 ') && f.includes('/api/llm/recent')) && !f.includes('status of 404'))).toEqual([]);
});

// The fleet list shows only AI-category services, and the accelerator anchors are always drawn:
// four device roles plus the cloud node, each named from its device labels (the vendor word
// dropped, the role tag added where two anchors read alike). A model sits on the anchor whose host
// its serving URL names. Each anchor's request beads are counted on its label, on both render paths.
const ANCHOR_NAMES = {
  'gpu-primary': 'Example GPU 1',
  'gpu-secondary': 'Example GPU 2',
  'mac-primary': 'Example Chip 3 · PRIMARY',
  'mac-secondary': 'Example Chip 3 · SECONDARY',
  cloud: 'cloud',
} as const;

// Accelerator attachment under failed or empty feeds, and split request counts. The expected
// data-active and data-models values are listed in ANCHOR_IDS order.
const ANCHOR_IDS = ['gpu-primary', 'gpu-secondary', 'mac-primary', 'mac-secondary', 'cloud'] as const;
const DEVICE_QUERIES = ['DCGM_FI_DEV_GPU_UTIL', 'macmon_gpu_usage_ratio'];
const ATTACHMENT_CASES: Array<{ name: string; feeds: FeedOpts; active: string[]; models: string[] }> = [
  // No device rows: no model has a device host, and every in-flight request falls to cloud.
  { name: 'device queries fail', feeds: { failQuery: (q) => DEVICE_QUERIES.some((d) => q.includes(d)) }, active: ['0', '0', '0', '0', '3'], models: ['0', '0', '0', '0', '4'] },
  { name: 'device queries return no rows', feeds: { emptyQuery: (q) => DEVICE_QUERIES.some((d) => q.includes(d)) }, active: ['0', '0', '0', '0', '3'], models: ['0', '0', '0', '0', '4'] },
  // No serving URLs: every model sits on cloud, while the device rows still draw their own anchors.
  { name: 'llmApiBase fails', feeds: { failQuery: (q) => q.includes('api_base') }, active: ['0', '0', '0', '0', '3'], models: ['0', '0', '0', '0', '4'] },
  { name: 'llmApiBase returns no rows', feeds: { emptyQuery: (q) => q.includes('api_base') }, active: ['0', '0', '0', '0', '3'], models: ['0', '0', '0', '0', '4'] },
  // Two local requests against one router in-flight request: the device share is drawn, cloud clamps to zero.
  { name: 'local total exceeds router in-flight', feeds: { inflight: 1, vllmRunning: 2 }, active: ['2', '0', '0', '0', '0'], models: ['1', '1', '0', '0', '2'] },
  // Neither local host matches a device, so their live requests stay on cloud with the rest.
  { name: 'unmatched hosts have live requests', feeds: { emptyQuery: (q) => DEVICE_QUERIES.some((d) => q.includes(d)), inflight: 5, vllmRunning: 2, llamaRunning: 1 }, active: ['0', '0', '0', '0', '5'], models: ['0', '0', '0', '0', '4'] },
];

for (const mode of ['2d', '3d'] as const) {
  test(`mc3 ${mode}: the fleet list is AI-only and all five anchors draw with their names`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok');
    // autobrr is a catalog service outside the AI category: the list holds the three AI services only.
    await expect(page.locator('#applist .ar')).toHaveCount(3);
    await expect(page.locator('#applist')).toContainText('kilo');
    await expect(page.locator('#applist')).not.toContainText('autobrr');
    await expect(page.locator('#subtitle')).toContainText('3 SERVICES');

    await expect(page.locator('#anchors .anchor')).toHaveCount(5);
    for (const [id, name] of Object.entries(ANCHOR_NAMES)) {
      await expect(page.locator(`#anchors [data-accel="${id}"] .an`)).toHaveText(name);
    }
    // gpu-secondary reads 64% busy. mac-secondary has no busy series: no data, and it dims.
    await expect(page.locator('#anchors [data-accel="gpu-secondary"] .ab')).toHaveText('64% busy');
    await expect(page.locator('#anchors [data-accel="mac-secondary"] .ab')).toHaveText('no data');
    await expect(page.locator('#anchors [data-accel="mac-secondary"]')).toHaveClass(/dim/);
    // Models attach to the device their serving URL names. Hosted rungs have no URL host: cloud.
    await expect(page.locator('#anchors [data-accel="gpu-primary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="gpu-secondary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '2');
    await expect(page.locator('#modeltab .mc').filter({ hasText: 'model-large' }).locator('.mcat')).toHaveText(ANCHOR_NAMES['gpu-primary']);
    await expect(page.locator('.kpi', { hasText: 'active' }).locator('b')).toContainText('3');
    expect(faults).toEqual([]);
  });

  test(`mc3 ${mode}: a scene with no models still draws all five anchors`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, { emptyQuery: (q) => q.includes('litellm_deployment_state') });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#subtitle')).toContainText('0 MODELS');
    await expect(page.locator('#anchors .anchor')).toHaveCount(5);
    for (const [id, name] of Object.entries(ANCHOR_NAMES)) {
      await expect(page.locator(`#anchors [data-accel="${id}"] .an`)).toHaveText(name);
    }
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '0');
    await expect(page.locator('#anchors [data-accel="cloud"] .as')).toHaveText('no models');
    expect(faults).toEqual([]);
  });

  // Every label box sits inside the viewport with a margin, right of the fleet panel and above the model
  // tile strip, and every name is shown whole (no ellipsis), on both render paths.
  test(`mc3 ${mode}: every anchor label stays inside the viewport, clear of the fleet panel and tile strip`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#anchors .anchor')).toHaveCount(5);
    const layout = await page.evaluate(() => {
      const box = (el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
      return {
        vw: innerWidth,
        vh: innerHeight,
        fleet: box(document.getElementById('apps')!),
        strip: box(document.getElementById('modeltab')!),
        labels: [...document.querySelectorAll('#anchors .anchor')].map((el) => ({
          accel: (el as HTMLElement).dataset.accel,
          box: box(el.querySelector('.alab')!),
          name: el.querySelector('.an')!.scrollWidth <= el.querySelector('.an')!.clientWidth + 1,
        })),
      };
    });
    expect(layout.strip.bottom).toBeGreaterThan(layout.strip.top);
    for (const { accel, box, name } of layout.labels) {
      expect(box.left, `${accel} label left edge`).toBeGreaterThanOrEqual(layout.fleet.right + 8);
      expect(box.right, `${accel} label right edge`).toBeLessThanOrEqual(layout.vw - 8);
      expect(box.top, `${accel} label top edge`).toBeGreaterThanOrEqual(8);
      expect(box.bottom, `${accel} label bottom edge`).toBeLessThanOrEqual(layout.strip.top - 8);
      expect(name, `${accel} name shown whole`).toBe(true);
    }
    expect(faults).toEqual([]);
  });

  // A model with several serving URLs attaches to the first device, in anchor order, that one of them
  // names. A hosted URL written after a local one does not hide the device.
  test(`mc3 ${mode}: a model with several serving URLs attaches to its first matched device in anchor order`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, {
      extraApiBase: [
        // model-mini: a local URL on the second Mac, then a hosted URL written last.
        { litellm_model_name: 'model-mini', api_base: 'http://[2001:db8::2]:8000/v1', api_provider: 'local' },
        { litellm_model_name: 'model-mini', api_base: 'https://api.example.test/v1', api_provider: 'openrouter' },
        // model-large: a second local URL on the first Mac. gpu-primary comes first in anchor order, so it keeps the model.
        { litellm_model_name: 'model-large', api_base: 'http://[2001:db8::1]:8000/v1', api_provider: 'local' },
      ],
    });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#anchors [data-accel="gpu-primary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="gpu-secondary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="mac-primary"]')).toHaveAttribute('data-models', '0');
    await expect(page.locator('#anchors [data-accel="mac-secondary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#modeltab .mc').filter({ hasText: 'model-mini' }).locator('.mcat')).toHaveText(ANCHOR_NAMES['mac-secondary']);
    expect(faults).toEqual([]);
  });

  // A model whose serving URLs are all hosted (two hosted rows here) sits on cloud.
  test(`mc3 ${mode}: a model with two hosted serving URLs sits on cloud`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, {
      extraApiBase: [{ litellm_model_name: 'model-small', api_base: 'https://api.example.test/v1', api_provider: 'openai' }],
    });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '2');
    await expect(page.locator('#anchors [data-accel="gpu-primary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="gpu-secondary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="mac-primary"]')).toHaveAttribute('data-models', '0');
    await expect(page.locator('#anchors [data-accel="mac-secondary"]')).toHaveAttribute('data-models', '0');
    expect(faults).toEqual([]);
  });

  // The second gpu-secondary host (gpu-host-c) gets a serving URL and a local server, written in upper case.
  // Both models map to gpu-secondary, and its request count adds up across both hosts.
  test(`mc3 ${mode}: a device's models and requests aggregate every host that reports it`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, {
      inflight: 10,
      llamaRunning: 3,
      extraLocal: [['GPU-HOST-C.example.test:8001', 2]],
      extraApiBase: [{ litellm_model_name: 'model-small', api_base: 'http://gpu-host-c.example.test:8001/v1', api_provider: 'local' }],
    });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    const gpuSecondary = page.locator('#anchors [data-accel="gpu-secondary"]');
    await expect(gpuSecondary.locator('.an')).toHaveText(ANCHOR_NAMES['gpu-secondary']);
    await expect(gpuSecondary).toHaveAttribute('data-models', '2');
    await expect(gpuSecondary).toHaveAttribute('data-active', '5');
    await expect(gpuSecondary).toHaveAttribute('data-beads', '5');
    await expect(page.locator('#anchors [data-accel="gpu-primary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-active', '5');
    expect(faults).toEqual([]);
  });

  // The 2D stream gate matches the 3D one. Two up models have tokens in flight (model-large, model-coder);
  // model-mini is up but idle, so neither render path draws its stream. The reactor canvas records the count.
  test(`mc3 ${mode}: an up model with no tokens in flight draws no stream`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#reactor')).toHaveAttribute('data-streams', '2');
    expect(faults).toEqual([]);
  });

  // An idle anchor (busy, but no model or request on it) and a no-data anchor render dim. The reactor
  // canvas lists the dim anchors as the render path drew them, so both modes must list the same ones.
  test(`mc3 ${mode}: an idle anchor and a no-data anchor render dim`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    // mac-primary reads 20% busy with nothing on it; mac-secondary has no busy series.
    await expect(page.locator('#reactor')).toHaveAttribute('data-dim-anchors', 'mac-primary,mac-secondary');
    await expect(page.locator('#anchors [data-accel="mac-primary"]')).toHaveClass(/dim/);
    await expect(page.locator('#anchors [data-accel="mac-secondary"]')).toHaveClass(/dim/);
    await expect(page.locator('#anchors [data-accel="gpu-primary"]')).not.toHaveClass(/dim/);
    expect(faults).toEqual([]);
  });

  // With both models routed to devices and no requests in flight, cloud has nothing on it: it renders dim.
  test(`mc3 ${mode}: a cloud node with no models or requests renders dim`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, {
      inflight: 0,
      extraApiBase: [
        { litellm_model_name: 'model-mini', api_base: 'http://gpu-host-a.example.test:8000/v1', api_provider: 'local' },
        { litellm_model_name: 'model-small', api_base: 'http://gpu-host-b.example.test:8080/v1', api_provider: 'local' },
      ],
    });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#reactor')).toHaveAttribute('data-dim-anchors', 'mac-primary,mac-secondary,cloud');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveClass(/dim/);
    await expect(page.locator('#anchors [data-accel="gpu-primary"]')).not.toHaveClass(/dim/);
    expect(faults).toEqual([]);
  });

  // Bracketed IPv6 hosts (documentation-range 2001:db8::/32) are read whole: a local server on one IPv6
  // device and a serving URL on the other each attach to their own device.
  test(`mc3 ${mode}: bracketed IPv6 hosts stay distinct for requests and serving URLs`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, {
      inflight: 2,
      extraLocal: [['[2001:db8::1]:8000', 2]],
      extraApiBase: [{ litellm_model_name: 'model-small', api_base: 'http://[2001:db8::2]:8000/v1', api_provider: 'local' }],
    });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#anchors [data-accel="mac-primary"]')).toHaveAttribute('data-active', '2');
    await expect(page.locator('#anchors [data-accel="mac-secondary"]')).toHaveAttribute('data-active', '0');
    await expect(page.locator('#anchors [data-accel="mac-secondary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-active', '0');
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '1');
    expect(faults).toEqual([]);
  });

  for (const c of ATTACHMENT_CASES) {
    test(`mc3 ${mode}: ${c.name} still draws five anchors with the requests and models on the right nodes`, async ({ page }) => {
      test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
      if (mode === '3d') test.slow();
      const faults = watchFaults(page);
      await mockFeeds(page, c.feeds);
      await page.goto(`/mc3/?gl=${mode}`);
      await awaitReady(page, mode);
      await expect(page.locator('[data-panel="apps"]')).toHaveAttribute('data-state', 'ok');
      await expect(page.locator('#anchors .anchor')).toHaveCount(5);
      for (const [i, id] of ANCHOR_IDS.entries()) {
        const el = page.locator(`#anchors [data-accel="${id}"]`);
        await expect(el).toHaveAttribute('data-active', c.active[i]);
        await expect(el).toHaveAttribute('data-models', c.models[i]);
      }
      // Only the forced 500 from the feed under test is expected; anything else is a fault.
      expect(faults.filter((f) => !(f.startsWith('500 ') && f.includes('/api/prom/')) && !f.includes('status of 500'))).toEqual([]);
    });
  }

  // The base fixture writes model-coder's serving host in mixed case and reports host-b from two
  // exporter ports. Both attach by host, and the repeated device name is listed once.
  test(`mc3 ${mode}: a mixed-case serving host and repeated device rows attach to one anchor`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page);
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    await expect(page.locator('#anchors [data-accel="gpu-secondary"]')).toHaveAttribute('data-models', '1');
    await expect(page.locator('#anchors [data-accel="gpu-secondary"] .an')).toHaveText(ANCHOR_NAMES['gpu-secondary']);
    await expect(page.locator('#modeltab .mc').filter({ hasText: 'model-coder' }).locator('.mcat')).toHaveText(ANCHOR_NAMES['gpu-secondary']);
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-models', '2');
    expect(faults).toEqual([]);
  });

  // 1 vs 8 vs 25 active: beads are drawn one each up to 12, then packed into rings with a ×N badge.
  for (const inflight of [0, 3, 25]) {
    test(`mc3 ${mode}: ${inflight} in flight draws ${inflight} beads on the cloud node`, async ({ page }) => {
      test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
      if (mode === '3d') test.slow();
      const faults = watchFaults(page);
      await mockFeeds(page, { inflight });
      await page.goto(`/mc3/?gl=${mode}`);
      await awaitReady(page, mode);
      const cloud = page.locator('#anchors [data-accel="cloud"]');
      await expect(cloud).toHaveAttribute('data-active', String(inflight));
      await expect(cloud).toHaveAttribute('data-beads', String(inflight));
      if (inflight > 12) await expect(cloud.locator('.badge')).toHaveText(`×${inflight}`);
      else await expect(cloud.locator('.badge')).toHaveCount(0);
      await expect(page.locator('.kpi', { hasText: 'active' }).locator('b')).toContainText(String(inflight));
      expect(faults).toEqual([]);
    });
  }

  test(`mc3 ${mode}: a local server's requests count against its device anchor, not the cloud node`, async ({ page }) => {
    test.skip(!!wallUrl, 'exercises the fixture-shaped feeds only');
    if (mode === '3d') test.slow();
    const faults = watchFaults(page);
    await mockFeeds(page, { inflight: 8, vllmRunning: 8 });
    await page.goto(`/mc3/?gl=${mode}`);
    await awaitReady(page, mode);
    const gpu = page.locator('#anchors [data-accel="gpu-primary"]');
    await expect(gpu).toHaveAttribute('data-active', '8');
    await expect(gpu).toHaveAttribute('data-beads', '8');
    await expect(gpu.locator('.badge')).toHaveCount(0);
    await expect(page.locator('#anchors [data-accel="cloud"]')).toHaveAttribute('data-active', '0');
    expect(faults).toEqual([]);
  });
}
