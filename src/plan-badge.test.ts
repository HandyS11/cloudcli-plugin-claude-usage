import test from 'node:test';
import assert from 'node:assert/strict';
import { planLabel } from './index.js';

test('planLabel shows the plan display name, with the raw codes as hover text', () => {
  assert.deepEqual(
    planLabel({ plan: 'max', tier: 'default_claude_max_20x', planName: 'Ultra' }),
    { text: 'Ultra', title: 'max · max_20x' },
  );
});

test('planLabel falls back to the raw codes when the display name is unknown', () => {
  assert.deepEqual(
    planLabel({ plan: 'max', tier: 'default_claude_max_20x', planName: null }),
    { text: 'max · max_20x', title: null },
  );
  assert.deepEqual(planLabel({ plan: 'pro', tier: null, planName: null }), { text: 'pro', title: null });
});

test('planLabel shows the display name even without raw codes', () => {
  assert.deepEqual(planLabel({ plan: null, tier: null, planName: 'Ultra' }), { text: 'Ultra', title: null });
});

test('planLabel returns null when there is nothing to show', () => {
  assert.equal(planLabel(null), null);
  assert.equal(planLabel({ plan: null, tier: null, planName: null }), null);
});
