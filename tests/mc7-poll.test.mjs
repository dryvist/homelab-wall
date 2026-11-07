import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a render failure in one poll still schedules the next poll', async (t) => {
  const status = {};
  const panel = { dataset: {}, querySelector: () => null, children: [] };
  Object.defineProperty(panel, 'innerHTML', { set() { throw new Error('render failed'); } });
  const originals = {
    window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  t.after(() => Object.assign(globalThis, originals));
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.document = {
    hidden: false, addEventListener() {}, getElementById: (id) => (id === 'status' ? status : panel),
  };
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(
    path === '/config.json' ? { refreshSeconds: 15 } : { status: 'success', data: { result: [] } },
  ));
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (_callback, delay) => { delays.push(delay); return delays.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  await import('../site/mc7/mc7.js?render-failure-polls');
  for (let tick = 0; tick < 50 && !delays.includes(15_000); tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(status.textContent, 'Telemetry refresh failed · retrying');
  assert.ok(delays.includes(15_000));
});

test('MC7 retries startup configuration after a rejected request', async (t) => {
  const status = {};
  const panel = { dataset: {}, querySelector: () => null, children: [] };
  const originals = {
    window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  t.after(() => Object.assign(globalThis, originals));
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.document = {
    hidden: false, addEventListener() {}, getElementById: (id) => (id === 'status' ? status : panel),
  };
  let configs = 0;
  t.mock.method(globalThis, 'fetch', (path) => {
    if (path === '/config.json') {
      configs += 1;
      if (configs === 1) return Promise.reject(new Error('temporary config failure'));
      return Promise.resolve(Response.json({ refreshSeconds: 15 }));
    }
    return new Promise(() => {});
  });
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  await import('../site/mc7/mc7.js?config-rejection-retry');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, 'Configuration unavailable · retrying');
  const retry = timers.filter((timer) => timer.delay === 10_000).at(-1);
  assert.ok(retry);
  retry.callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configs, 2);
});
