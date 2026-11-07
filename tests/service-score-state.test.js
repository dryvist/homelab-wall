import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceScoreState } from '../site/lib/serviceScoreState.js';

test('a failed first score query with no held scores is an error', () => {
  assert.equal(serviceScoreState(true, false), 'error');
});

test('a failed score query with held scores is stale', () => {
  assert.equal(serviceScoreState(true, true), 'stale');
});

test('a successful scored query after a failure is ok', () => {
  assert.equal(serviceScoreState(false, true), 'ok');
});

test('a successful empty score query is empty', () => {
  assert.equal(serviceScoreState(false, false), 'empty');
});
