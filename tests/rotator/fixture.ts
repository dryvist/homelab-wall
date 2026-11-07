
// Self-contained fixture — deliberately does not import tests/fixture.ts, which belongs to the
// mc1/panel-contract suite and is being edited concurrently by another lane.
export const SLIDES = [
  { name: 'Slide A', url: '/slide-a', seconds: 10 },
  { name: 'Slide B', url: '/slide-b', seconds: 10 },
  { name: 'Slide C', url: '/slide-c', seconds: 10 },
];

export async function mockSlides(page: import('@playwright/test').Page, holdSeconds = 30, brokenIndex = -1) {
  await page.route('**/config.json', (r) => r.fulfill({ json: { slides: SLIDES, holdSeconds } }));
  for (const [i, s] of SLIDES.entries()) {
    if (i === brokenIndex) {
      await page.route(`**${s.url}`, (r) => r.fulfill({ status: 404, body: 'not found' }));
    } else {
      // The rotator's ready handshake (site/rotator/rotator.js, Track G3): a same-origin slide
      // is only counted healthy once it posts {wall:'ready'} to its parent, the same message
      // site/lib/stage.js sends once a real MC page's first frame has painted. This fixture
      // stands in for that.
      await page.route(`**${s.url}`, (r) => r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>${s.name}</title><script>parent.postMessage({wall:'ready'},'*')</script>`,
      }));
    }
  }
}

// `ignore` excludes the browser's own network-status logging (e.g. "Failed to load resource:
// ... 404") for a deliberately-broken URL under test — that's the browser reporting the fetch
// probe's result, not an application bug.
export function watchFaults(page: import('@playwright/test').Page, ignore?: RegExp) {
  const faults: string[] = [];
  const record = (text: string) => { if (!ignore || !ignore.test(text)) faults.push(text); };
  page.on('pageerror', (e) => record(e.message));
  page.on('console', (m) => { if (m.type() === 'error') record(m.text()); });
  return faults;
}

export async function activeSlideUrl(page: import('@playwright/test').Page) {
  return page.locator('.layer.active').getAttribute('src');
}
