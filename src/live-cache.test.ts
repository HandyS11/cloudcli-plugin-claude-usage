import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCache, LIVE_CACHE_MS, parseRetryAfter, backoffMs, UsageResponse } from './live.js';

const BODY = { limits: [{ kind: 'session', percent: 10, severity: 'normal', resets_at: null }] };

function harness(responses: (UsageResponse | Error)[]) {
  let now = 1_000_000;
  let calls = 0;
  const cache = new LiveCache(
    async () => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls++;
      if (r instanceof Error) throw r;
      return r;
    },
    () => now,
  );
  return { cache, calls: () => calls, advance: (ms: number) => { now += ms; }, now: () => now };
}

const ok: UsageResponse = { status: 200, retryAfter: null, body: BODY, plan: 'max', tier: null };
const limited: UsageResponse = { status: 429, retryAfter: null, body: null, plan: 'max', tier: null };

test('first call fetches and reports when it was fetched', async () => {
  const h = harness([ok]);
  const r = await h.cache.get();
  assert.equal(h.calls(), 1);
  assert.equal(r.limits[0].percent, 10);
  assert.equal(r.fetchedAt, h.now());
  assert.equal(r.stale, false);
  assert.equal(r.error, null);
});

test('calls within the cache window do not hit the endpoint', async () => {
  const h = harness([ok]);
  await h.cache.get();
  h.advance(LIVE_CACHE_MS - 1);
  await h.cache.get();
  assert.equal(h.calls(), 1);
  h.advance(1);
  await h.cache.get();
  assert.equal(h.calls(), 2);
});

test('cache window is at least five minutes', () => {
  assert.ok(LIVE_CACHE_MS >= 5 * 60_000);
});

test('concurrent calls share one in-flight fetch', async () => {
  const h = harness([ok]);
  await Promise.all([h.cache.get(), h.cache.get(), h.cache.get()]);
  assert.equal(h.calls(), 1);
});

test('429 with cached data serves the stale reading and a retry time', async () => {
  const h = harness([ok, limited]);
  await h.cache.get();
  h.advance(LIVE_CACHE_MS);
  const r = await h.cache.get();
  assert.equal(h.calls(), 2);
  assert.equal(r.stale, true);
  assert.equal(r.limits[0].percent, 10);
  assert.match(r.error!, /429/);
  assert.equal(r.retryAt, h.now() + backoffMs(1));
});

test('no fetch happens until the retry time has passed', async () => {
  const h = harness([ok, limited, ok]);
  await h.cache.get();
  h.advance(LIVE_CACHE_MS);
  const r = await h.cache.get();
  h.advance(r.retryAt! - h.now() - 1);
  await h.cache.get();
  assert.equal(h.calls(), 2);
  h.advance(1);
  const fresh = await h.cache.get();
  assert.equal(h.calls(), 3);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.error, null);
});

test('429 honors the Retry-After header', async () => {
  const h = harness([{ ...limited, retryAfter: '900' }]);
  await assert.rejects(h.cache.get());
  h.advance(899_000);
  await assert.rejects(h.cache.get(), /429/);
  assert.equal(h.calls(), 1);
});

test('repeated 429s back off exponentially up to a cap', async () => {
  assert.equal(backoffMs(1), 5 * 60_000);
  assert.equal(backoffMs(2), 10 * 60_000);
  assert.equal(backoffMs(3), 20 * 60_000);
  assert.equal(backoffMs(4), 40 * 60_000);
  assert.equal(backoffMs(5), 60 * 60_000);
  assert.equal(backoffMs(9), 60 * 60_000);
});

test('consecutive 429s lengthen the wait; a success resets it', async () => {
  const h = harness([limited, limited, ok, limited]);
  await assert.rejects(h.cache.get());
  h.advance(backoffMs(1));
  await assert.rejects(h.cache.get());
  h.advance(backoffMs(2));
  await h.cache.get();
  h.advance(LIVE_CACHE_MS);
  const r = await h.cache.get();
  assert.equal(r.retryAt, h.now() + backoffMs(1));
});

test('429 without cached data throws a 429 with the wait in the message', async () => {
  const h = harness([limited]);
  await assert.rejects(h.cache.get(), (err: any) => err.status === 429 && /5 min/.test(err.message));
});

test('a thrown fetch error keeps stale data and retries at the normal interval', async () => {
  const h = harness([ok, new Error('boom'), ok]);
  await h.cache.get();
  h.advance(LIVE_CACHE_MS);
  const r = await h.cache.get();
  assert.equal(r.stale, true);
  assert.equal(r.error, 'boom');
  h.advance(LIVE_CACHE_MS);
  const fresh = await h.cache.get();
  assert.equal(fresh.stale, false);
  assert.equal(h.calls(), 3);
});

test('parseRetryAfter reads seconds and HTTP dates, ignores junk', () => {
  assert.equal(parseRetryAfter('120', 0), 120_000);
  assert.equal(parseRetryAfter('0', 0), null);
  assert.equal(parseRetryAfter('garbage', 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
  const now = Date.parse('2026-10-30T08:00:00Z');
  assert.equal(parseRetryAfter('Fri, 30 Oct 2026 08:10:00 GMT', now), 600_000);
  assert.equal(parseRetryAfter('Fri, 30 Oct 2026 07:00:00 GMT', now), null);
});

test('after a non-429 error, calls before the next interval do not re-fetch', async () => {
  const h = harness([ok, new Error('boom')]);
  await h.cache.get();
  h.advance(LIVE_CACHE_MS);
  await h.cache.get();
  h.advance(LIVE_CACHE_MS - 1);
  await h.cache.get();
  assert.equal(h.calls(), 2);
});
