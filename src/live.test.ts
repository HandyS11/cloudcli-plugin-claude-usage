import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentials, normalizeUsage } from './live.js';

const CREDS = {
  claudeAiOauth: {
    accessToken: 'sk-ant-test', refreshToken: 'never-read', expiresAt: 2000,
    subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
  },
};

test('parseCredentials extracts token, plan, expiry', () => {
  const c = parseCredentials(CREDS, 1000);
  assert.deepEqual(c, { accessToken: 'sk-ant-test', expired: false, plan: 'max', tier: 'default_claude_max_20x' });
  assert.equal(parseCredentials(CREDS, 3000)!.expired, true);
});

test('parseCredentials returns null for malformed input', () => {
  assert.equal(parseCredentials({}, 0), null);
  assert.equal(parseCredentials(null, 0), null);
});

const RAW = {
  limits: [
    { kind: 'session', percent: 43, severity: 'normal', resets_at: '2026-07-16T18:29:59Z', scope: null, is_active: true },
    { kind: 'weekly_all', percent: 12, severity: 'normal', resets_at: '2026-07-17T10:59:59Z', scope: null },
    { kind: 'weekly_scoped', percent: 15, severity: 'warning', resets_at: '2026-07-17T10:59:59Z', scope: { model: { id: null, display_name: 'Fable' } } },
    { kind: 'weird_new_kind', percent: 'not-a-number' }, // defensive: skipped
  ],
};

test('normalizeUsage maps known limits and skips malformed ones', () => {
  const live = normalizeUsage(RAW, 'max', '20x');
  assert.equal(live.plan, 'max');
  assert.equal(live.limits.length, 3);
  assert.deepEqual(live.limits[0], {
    kind: 'session', label: 'Session (5h)', percent: 43, severity: 'normal',
    resetsAt: '2026-07-16T18:29:59Z', model: null,
  });
  assert.equal(live.limits[1].label, 'Weekly (all models)');
  assert.equal(live.limits[2].label, 'Weekly — Fable');
  assert.equal(live.limits[2].model, 'Fable');
});

test('normalizeUsage tolerates missing limits array', () => {
  assert.deepEqual(normalizeUsage({}, null, null).limits, []);
});
