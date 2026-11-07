import assert from 'node:assert/strict';
import test from 'node:test';
import { assignModelColors, shortDevice } from '../site/lib/mc3.js';

const palette = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007', '#000008'];
const models = Array.from({ length: 8 }, (_, index) => ({ n: `model-${index}` }));

test('model colors are unique and stable by list position', () => {
  const first = assignModelColors(models, palette);
  assert.equal(new Set(first.map((model) => model.color)).size, 8);
  assert.deepEqual(first, assignModelColors(models, palette));
  assert.deepEqual(first.map((model) => model.color), palette);
});

test('device names keep the concise identifier and one short suffix', () => {
  assert.equal(shortDevice('VENDORX Brandname ABC 1234 SUPER'), 'ABC 1234 SUPER');
  assert.equal(shortDevice('VENDORX ABC PRO 6000 Codename Max-Q Workstation Edition'), 'ABC PRO 6000');
  assert.equal(shortDevice('Vendor M9 Max'), 'M9 Max');
  assert.equal(shortDevice('VENDORX Brandname Product'), 'Brandname Product');
  assert.equal(shortDevice(''), '');
  assert.equal(shortDevice(' \t '), '');
});
