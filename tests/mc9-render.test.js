import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Q } from '../site/lib/queries.js';
import { shapeNodes, ageLabel, refreshNode, withTimeout } from '../site/mc9/model.js';

test('the page expires labels, reporting count, and rings during an unfinished poll, then retries', { timeout: 1000 }, async () => {
  let now = 90000;
  let hung = false;
  let requests = 0;
  const intervals = [];
  const timeouts = [];
  const articles = [];
  const element = () => ({
    dataset: {}, style: { setProperty() {} }, textContent: '',
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    children: new Map(),
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, element());
      return this.children.get(selector);
    },
    appendChild(child) { articles.push(child); },
    getContext() { return {}; },
  });
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
  };
  const source = readFileSync(new URL('../site/mc9/mc9.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
  await runInNewContext(`(async () => { ${source} })()`, {
    document, Q, shapeNodes: (feeds, previous) => shapeNodes(feeds, previous, now), ageLabel, refreshNode,
    Date: class extends Date { static now() { return now * 1000; } },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    loadConfig: async () => ({ refreshSeconds: 1 }),
    loop() {}, observeCanvas() {}, onDispose() {},
    setInterval: (fn) => intervals.push(fn), clearInterval() {},
    setTimeout: (fn) => timeouts.push(fn), clearTimeout() {},
    withTimeout: (request) => withTimeout(request, 5),
    query: async (_, opts) => {
      requests += 1;
      assert.equal(opts.timestamps, true);
      if (hung) return new Promise(() => {});
      return [{ labels: {}, value: 3, timestamp: now }];
    },
    range: async (_, minutes, step, opts) => {
      assert.equal(minutes, 1440);
      assert.equal(step, 300);
      assert.equal(opts.timestamps, true);
      assert.equal(opts.align, true);
      return [{ labels: {}, values: [[now, 0]] }];
    },
  });
  await new Promise(setImmediate);
  const donna = articles.find((el) => el.dataset.node === 'donna');
  assert.equal(donna.dataset.state, 'active');
  assert.match(elements.get('status').textContent, /^6 signals reporting/);
  hung = true;
  const pending = timeouts.shift()();
  now += 301;
  intervals[0]();
  assert.equal(donna.dataset.state, 'stale');
  assert.match(donna.querySelector('.rate').textContent, /^STALE/);
  assert.match(elements.get('status').textContent, /^0 signals reporting/);
  assert.equal(elements.get('constellation').dataset.state, 'stale');
  now += 86400;
  intervals[0]();
  assert.equal(donna.querySelector('.history').textContent, 'History stale');
  await pending;
  assert.equal(timeouts.length, 1, 'a hung poll must schedule another poll after its deadline');
  const beforeRetry = requests;
  hung = false;
  await timeouts.shift()();
  assert(requests > beforeRetry);
  assert.equal(donna.dataset.state, 'active');
});
