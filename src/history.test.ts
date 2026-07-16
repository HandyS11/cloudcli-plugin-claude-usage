import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptLine, projectLabel, aggregate } from './history.js';

const LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-07-12T21:27:14.468Z',
  message: {
    id: 'msg_1', model: 'claude-opus-4-8',
    usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 },
  },
});

test('parseTranscriptLine extracts usage entry', () => {
  const e = parseTranscriptLine(LINE);
  assert.deepEqual(e, {
    id: 'msg_1',
    timestamp: '2026-07-12T21:27:14.468Z',
    model: 'claude-opus-4-8',
    tokens: { input: 2, output: 50, cacheCreate: 100, cacheRead: 200 },
  });
});

test('parseTranscriptLine ignores non-usage and invalid lines', () => {
  assert.equal(parseTranscriptLine('{"type":"queue-operation"}'), null);
  assert.equal(parseTranscriptLine('not json'), null);
  assert.equal(parseTranscriptLine(''), null);
  // synthetic model entries carry no real usage
  const synth = JSON.stringify({ timestamp: 't', message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 1 } } });
  assert.equal(parseTranscriptLine(synth), null);
});

test('parseTranscriptLine normalizes non-numeric token fields to 0', () => {
  const line = JSON.stringify({
    timestamp: '2026-07-12T00:00:00Z',
    message: {
      id: 'msg_bad', model: 'claude-opus-4-8',
      usage: { input_tokens: '12', cache_creation_input_tokens: null, cache_read_input_tokens: NaN, output_tokens: 7 },
    },
  });
  const e = parseTranscriptLine(line);
  assert.deepEqual(e?.tokens, { input: 0, output: 7, cacheCreate: 0, cacheRead: 0 });
});

test('projectLabel prettifies claude project dir names', () => {
  assert.equal(projectLabel('-home-cloudcli-projects-DotnetTokenKiller'), 'DotnetTokenKiller');
  assert.equal(projectLabel('-home-cloudcli'), 'home-cloudcli');
});

const NOW = Date.parse('2026-07-16T12:00:00Z');
function entry(id: string, ts: string, model = 'claude-opus-4-8', output = 10) {
  return { id, timestamp: ts, model, tokens: { input: 1, output, cacheCreate: 0, cacheRead: 0 } };
}

test('aggregate dedupes by message id and buckets by day', () => {
  const agg = aggregate(
    [{
      project: 'proj-a',
      entries: [
        entry('m1', '2026-07-15T10:00:00Z'),
        entry('m1', '2026-07-15T10:00:00Z'), // duplicate line — must count once
        entry('m2', '2026-07-16T09:00:00Z'),
      ],
    }],
    30, NOW,
  );
  assert.equal(agg.totals.messages, 2);
  assert.equal(agg.totals.tokens.output, 20);
  assert.equal(agg.totals.sessions, 1);
  assert.equal(agg.daily.length, 30);
  assert.equal(agg.daily[agg.daily.length - 1].date, '2026-07-16');
  assert.equal(agg.daily[agg.daily.length - 1].tokens.output, 10);
  assert.equal(agg.daily[agg.daily.length - 2].tokens.output, 10);
});

test('aggregate filters to window, breaks down by model and project', () => {
  const agg = aggregate(
    [
      { project: 'proj-a', entries: [entry('a1', '2026-07-16T01:00:00Z', 'claude-opus-4-8')] },
      { project: 'proj-b', entries: [entry('b1', '2026-07-16T02:00:00Z', 'claude-fable-5', 100)] },
      { project: 'proj-old', entries: [entry('c1', '2026-01-01T00:00:00Z')] }, // outside window
    ],
    30, NOW,
  );
  assert.equal(agg.totals.sessions, 2);
  assert.equal(agg.byModel.length, 2);
  assert.equal(agg.byModel[0].model, 'claude-fable-5'); // most tokens first
  assert.equal(agg.byProject.length, 2);
  assert.ok(agg.totals.cost > 0);
});

test('aggregate reports null cost for unknown models but counts tokens', () => {
  const agg = aggregate(
    [{ project: 'p', entries: [entry('x1', '2026-07-16T01:00:00Z', 'mystery-model')] }],
    30, NOW,
  );
  assert.equal(agg.byModel[0].cost, null);
  assert.equal(agg.totals.tokens.output, 10);
});

test('aggregate window aligns with daily calendar buckets', () => {
  const agg = aggregate(
    [{
      project: 'p',
      entries: [
        entry('w1', '2026-06-16T15:00:00Z'), // day before daily[0] — must be fully excluded
        entry('w2', '2026-06-17T00:30:00Z'), // first covered day — included
        entry('w3', '2026-07-16T23:00:00Z'), // later today (after nowMs, same UTC day) — included
        entry('w4', '2026-07-17T01:00:00Z'), // tomorrow — fully excluded
      ],
    }],
    30, NOW,
  );
  assert.equal(agg.totals.messages, 2);
  assert.equal(agg.daily[0].date, '2026-06-17');
  assert.equal(agg.daily[0].tokens.output, 10);
  assert.equal(agg.daily[agg.daily.length - 1].tokens.output, 10);
  // invariant: totals equals the sum of the daily series
  const dailySum = agg.daily.reduce((s, d) => s + d.tokens.output, 0);
  assert.equal(dailySum, agg.totals.tokens.output);
});
