import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSessions } from './transcripts.js';

const LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-10-30T08:00:00.000Z',
  message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 2 } },
});

function fixture(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-transcripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '-root-demo'));
  return dir;
}

test('loadSessions parses transcripts and skips what it cannot read', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '-root-demo', 'a.jsonl'), `${LINE}\nnot json\n${LINE}\n`);
  fs.mkdirSync(path.join(dir, '-root-demo', 'broken.jsonl'));
  const sessions = await loadSessions(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].entries.length, 2);
});

test('a missing projects directory yields no sessions', async (t) => {
  assert.deepEqual(await loadSessions(path.join(fixture(t), 'absent')), []);
});

test('the event loop keeps turning while a large transcript is parsed', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '-root-demo', 'big.jsonl'), `${LINE}\n`.repeat(50_000));
  let turns = 0;
  let scanning = true;
  const spin = () => { if (scanning) { turns++; setImmediate(spin); } };
  setImmediate(spin);
  const sessions = await loadSessions(dir);
  scanning = false;
  assert.equal(sessions[0].entries.length, 50_000);
  assert.ok(turns > 10, `expected the loop to keep turning, got ${turns} turns`);
});

test('concurrent callers share one scan', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '-root-demo', 'a.jsonl'), `${LINE}\n`);
  const first = loadSessions(dir);
  assert.equal(loadSessions(dir), first);
  await first;
});
