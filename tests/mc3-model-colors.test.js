import assert from 'node:assert/strict';
import test from 'node:test';
import { assignModelColors } from '../site/lib/mc3.js';

const palette = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007', '#000008'];
const models = Array.from({ length: 8 }, (_, index) => ({ n: `model-${index}` }));

test('model colors are unique and stable by list position', () => {
  const first = assignModelColors(models, palette);
  assert.equal(new Set(first.map((model) => model.color)).size, 8);
  assert.deepEqual(first, assignModelColors(models, palette));
  assert.deepEqual(first.map((model) => model.color), palette);
});
