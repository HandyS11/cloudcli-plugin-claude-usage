import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanName, PlanNameCache, PROFILE_CACHE_MS, PROFILE_RETRY_MS } from './profile.js';

const PROFILE = {
  organization: {
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_20x',
    plan_display_name: 'Ultra',
    plan_display_label: 'Ultra plan',
  },
};

test('parsePlanName reads organization.plan_display_name', () => {
  assert.equal(parsePlanName(PROFILE), 'Ultra');
});

test('parsePlanName returns null when the name is missing, empty or not a string', () => {
  assert.equal(parsePlanName(null), null);
  assert.equal(parsePlanName({}), null);
  assert.equal(parsePlanName({ organization: { plan_display_name: '' } }), null);
  assert.equal(parsePlanName({ organization: { plan_display_name: '   ' } }), null);
  assert.equal(parsePlanName({ organization: { plan_display_name: { nested: true } } }), null);
});

function harness(responses: (unknown | Error)[]) {
  let now = 1_000_000;
  const tokens: string[] = [];
  const cache = new PlanNameCache(
    async (token) => {
      const r = responses[Math.min(tokens.length, responses.length - 1)];
      tokens.push(token);
      if (r instanceof Error) throw r;
      return r;
    },
    () => now,
  );
  return { cache, calls: () => tokens.length, tokens, advance: (ms: number) => { now += ms; } };
}

test('first get fetches the profile with the given token', async () => {
  const h = harness([PROFILE]);
  assert.equal(await h.cache.get('tok-a'), 'Ultra');
  assert.deepEqual(h.tokens, ['tok-a']);
});

test('gets within the cache window reuse the cached name', async () => {
  const h = harness([PROFILE]);
  await h.cache.get('tok-a');
  h.advance(PROFILE_CACHE_MS - 1);
  assert.equal(await h.cache.get('tok-a'), 'Ultra');
  assert.equal(h.calls(), 1);
  h.advance(1);
  await h.cache.get('tok-a');
  assert.equal(h.calls(), 2);
});

test('cache window is at least an hour', () => {
  assert.ok(PROFILE_CACHE_MS >= 60 * 60_000);
});

test('a new access token (fresh login) refetches at once', async () => {
  const h = harness([PROFILE, { organization: { plan_display_name: 'Max' } }]);
  await h.cache.get('tok-a');
  assert.equal(await h.cache.get('tok-b'), 'Max');
  assert.deepEqual(h.tokens, ['tok-a', 'tok-b']);
});

test('a failed first fetch resolves to null instead of throwing', async () => {
  const h = harness([new Error('HTTP 500')]);
  assert.equal(await h.cache.get('tok-a'), null);
});

test('a profile without a plan name resolves to null', async () => {
  const h = harness([{ organization: {} }]);
  assert.equal(await h.cache.get('tok-a'), null);
});

test('a failed refresh keeps the last known name and retries sooner', async () => {
  const h = harness([PROFILE, new Error('HTTP 429'), PROFILE]);
  await h.cache.get('tok-a');
  h.advance(PROFILE_CACHE_MS);
  assert.equal(await h.cache.get('tok-a'), 'Ultra');
  assert.equal(h.calls(), 2);
  h.advance(PROFILE_RETRY_MS - 1);
  await h.cache.get('tok-a');
  assert.equal(h.calls(), 2);
  h.advance(1);
  await h.cache.get('tok-a');
  assert.equal(h.calls(), 3);
});

test('concurrent gets share one in-flight fetch', async () => {
  const h = harness([PROFILE]);
  const names = await Promise.all([h.cache.get('tok-a'), h.cache.get('tok-a'), h.cache.get('tok-a')]);
  assert.deepEqual(names, ['Ultra', 'Ultra', 'Ultra']);
  assert.equal(h.calls(), 1);
});
