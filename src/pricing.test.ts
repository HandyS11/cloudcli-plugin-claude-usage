import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost } from './pricing.js';

const M = 1_000_000;

test('opus 4.8 pricing', () => {
  // $5 in, $25 out, $6.25 cache write, $0.50 cache read per MTok
  const cost = estimateCost('claude-opus-4-8', {
    input: 1 * M, output: 1 * M, cacheCreate: 1 * M, cacheRead: 1 * M,
  });
  assert.equal(cost, 5 + 25 + 6.25 + 0.5);
});

test('fable pricing', () => {
  const cost = estimateCost('claude-fable-5', {
    input: 1 * M, output: 0, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 10);
});

test('haiku 4.5 pricing', () => {
  const cost = estimateCost('claude-haiku-4-5-20251001', {
    input: 0, output: 1 * M, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 5);
});

test('unknown model returns null', () => {
  assert.equal(estimateCost('gpt-4o', { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }), null);
  assert.equal(estimateCost('<synthetic>', { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }), null);
});

test('legacy opus 4.1 uses old pricing', () => {
  const cost = estimateCost('claude-opus-4-1-20250805', {
    input: 1 * M, output: 0, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 15);
});

test('claude 3 opus uses legacy pricing', () => {
  const cost = estimateCost('claude-3-opus-20240229', {
    input: 1 * M, output: 0, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 15);
});
