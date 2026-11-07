import { test } from '@playwright/test';
import './rotator/navigation.cases';
import './rotator/recovery.cases';
import './rotator/reload.cases';
import './rotator/worker.cases';

// rotator.js registers a real service worker unconditionally (site/sw.js). Almost none of these
// tests are about that worker, and letting it register anyway means its background install-time
// fetches (hashing rotator.js, precaching the shell) compete with the single-threaded dev server
// used across the whole file, which has produced flaky timing elsewhere in this suite. Blocking
// /sw.js by default removes that noise; the two tests that actually cover the service worker call
// page.unroute('**/sw.js') first to let it register for real.
test.beforeEach(async ({ page }) => {
  await page.route('**/sw.js', (route) => route.abort());
});
