import assert from 'node:assert/strict';
import test from 'node:test';
import { assignModelColors, shortDevice } from '../site/lib/mc3.js';

const palette = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007', '#000008'];
const models = Array.from({ length: 8 }, (_, index) => ({ n: `model-${index}` }));

test('model colors are unique and stay with the model when the order changes', () => {
  const first = assignModelColors(models, palette);
  assert.equal(new Set(first.map((model) => model.color)).size, 8);
  const reversed = assignModelColors([...models].reverse(), palette);
  for (const { n, color } of first) assert.equal(reversed.find((model) => model.n === n).color, color);
});

test('device names keep the concise identifier and one short suffix', () => {
  assert.equal(shortDevice('VENDORX Brandname ABC 1234 SUPER'), 'ABC 1234 SUPER');
  assert.equal(shortDevice('VENDORX ABC PRO 6000 Codename Max-Q Workstation Edition'), 'ABC PRO 6000');
  assert.equal(shortDevice('Vendor M9 Max'), 'M9 Max');
  assert.equal(shortDevice('VENDORX Brandname Product'), 'Brandname Product');
  assert.equal(shortDevice('Example Chip 3'), 'Example Chip 3');
  assert.equal(shortDevice('VENDORX Example GPU 2'), 'GPU 2');
  assert.equal(shortDevice(''), '');
  assert.equal(shortDevice(' \t '), '');
});
