import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuByNode } from '../site/lib/mc1Metrics.js';

const model = (accelerator, instance) => ({ labels: { accelerator, instance }, value: 1 });
const guest = (name, node) => ({ labels: { name, node }, value: 1 });
const busy = (accelerator, value) => ({ labels: { accelerator }, value });

test('GPU readings map guests to nodes and take the busiest mapped accelerator', () => {
  const readings = gpuByNode(
    [model('accel-a', 'guest-a.example.test:9400'), model('accel-b', 'guest-b.example.test:9400'), model('accel-c', 'guest-c.example.test:9400'), model('accel-unmapped', 'guest-x.example.test:9400')],
    [guest('guest-a', 'node-a'), guest('guest-b', 'node-b'), guest('guest-c', 'node-b')],
    [busy('accel-a', 35), busy('accel-b', 42), busy('accel-c', 68)],
  );

  assert.deepEqual(readings.get('node-a'), { hasAccelerator: true, value: 35 });
  assert.deepEqual(readings.get('node-b'), { hasAccelerator: true, value: 68 });
  assert.equal(readings.has('node-c'), false);
});

test('a mapped accelerator without a busy series remains present with no reading', () => {
  const readings = gpuByNode([model('accel-a', 'guest-a.example.test:9400')], [guest('guest-a', 'node-a')], []);
  assert.deepEqual(readings.get('node-a'), { hasAccelerator: true, value: null });
});
