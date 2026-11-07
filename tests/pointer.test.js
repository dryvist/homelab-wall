import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointer } from '../site/lib/pointer.js';

function fakeWindow({ topLevel = true, width = 200, height = 100 } = {}) {
  const listeners = new Map();
  const frames = new Map();
  let nextFrame = 1;
  const win = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    flushFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
    get listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
    get pendingFrames() { return frames.size; },
  };
  win.self = win;
  win.top = topLevel ? win : {};
  return win;
}

function mediaQueries({ reduced = false, coarse = false } = {}) {
  return (query) => ({ matches: query.includes('prefers-reduced-motion') ? reduced : coarse });
}

test('pointer follows top-level mouse input once per frame in normalized screen coordinates', () => {
  const win = fakeWindow();
  const { pointer, dispose } = createPointer({ win, matchMedia: mediaQueries() });
  assert.deepEqual(pointer, { x: 0, y: 0, active: false });

  win.dispatch('pointermove', { clientX: 200, clientY: 0 });
  win.dispatch('pointermove', { clientX: -20, clientY: 120 });
  assert.equal(win.pendingFrames, 1);
  assert.deepEqual(pointer, { x: 0, y: 0, active: false });

  win.flushFrame();
  assert.deepEqual(pointer, { x: -1, y: -1, active: true });
  dispose();
});

test('pointer stays inactive in an embedded page', () => {
  const win = fakeWindow({ topLevel: false });
  const { pointer } = createPointer({ win, matchMedia: mediaQueries() });
  win.dispatch('pointermove', { clientX: 100, clientY: 50 });
  assert.deepEqual(pointer, { x: 0, y: 0, active: false });
  assert.equal(win.listenerCount, 0);
});

test('pointer stays inactive when reduced motion is requested', () => {
  const win = fakeWindow();
  const { pointer } = createPointer({ win, matchMedia: mediaQueries({ reduced: true }) });
  win.dispatch('pointermove', { clientX: 200, clientY: 0 });
  assert.deepEqual(pointer, { x: 0, y: 0, active: false });
  assert.equal(win.listenerCount, 0);
});

test('pointer stays inactive for a coarse pointer', () => {
  const win = fakeWindow();
  const { pointer } = createPointer({ win, matchMedia: mediaQueries({ coarse: true }) });
  win.dispatch('pointermove', { clientX: 200, clientY: 0 });
  assert.deepEqual(pointer, { x: 0, y: 0, active: false });
  assert.equal(win.listenerCount, 0);
});

test('pointer eases back to the centre after leaving the window', () => {
  const win = fakeWindow();
  const { pointer, dispose } = createPointer({ win, matchMedia: mediaQueries() });
  win.dispatch('pointermove', { clientX: 200, clientY: 0 });
  win.flushFrame();
  assert.deepEqual(pointer, { x: 1, y: 1, active: true });

  win.dispatch('pointerout', { relatedTarget: {} });
  win.flushFrame();
  assert.equal(pointer.active, true);
  win.dispatch('pointerout');
  win.flushFrame();
  assert.equal(pointer.active, false);
  assert.ok(pointer.x > 0 && pointer.x < 1);
  assert.ok(pointer.y > 0 && pointer.y < 1);
  for (let i = 0; i < 80 && win.pendingFrames; i += 1) win.flushFrame();
  assert.deepEqual(pointer, { x: 0, y: 0, active: false });
  dispose();
});

test('dispose removes listeners and cancels a pending frame', () => {
  const win = fakeWindow();
  const { dispose } = createPointer({ win, matchMedia: mediaQueries() });
  win.dispatch('pointermove', { clientX: 100, clientY: 50 });
  assert.equal(win.listenerCount, 2);
  assert.equal(win.pendingFrames, 1);
  dispose();
  assert.equal(win.listenerCount, 0);
  assert.equal(win.pendingFrames, 0);
});
