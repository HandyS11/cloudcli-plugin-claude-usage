import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCredentials, LiveCache, LiveResult, Credentials } from './live.js';
import { aggregate } from './history.js';
import { loadSessions } from './transcripts.js';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// ── /live ──────────────────────────────────────────────────────────────

/** Local, no-network checks — never throttled, so a fresh login shows up immediately. */
function readCredentials(): Credentials {
  let credsJson: unknown;
  try {
    credsJson = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf-8'));
  } catch {
    throw Object.assign(new Error('No Claude Code credentials found — sign in with the claude CLI first.'), { status: 404 });
  }
  const creds = parseCredentials(credsJson, Date.now());
  if (!creds) throw Object.assign(new Error('Unrecognized credentials file format.'), { status: 500 });
  if (creds.expired) {
    throw Object.assign(new Error('OAuth token expired — run claude to refresh it, then retry.'), { status: 401 });
  }
  return creds;
}

// The endpoint is shared with Claude Code's own /usage screen and rate-limits
// after only a few calls, so LiveCache polls it at most every 5 minutes and
// backs off on 429 (see live.ts).
const liveCache = new LiveCache(async () => {
  const creds = readCredentials();
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: res.ok ? await res.json() : null,
    plan: creds.plan,
    tier: creds.tier,
  };
});

async function getLive(): Promise<LiveResult> {
  readCredentials();
  return liveCache.get();
}

// ── /history ───────────────────────────────────────────────────────────

async function getHistory(days: number) {
  return aggregate(await loadSessions(path.join(CLAUDE_DIR, 'projects')), days, Date.now());
}

// ── HTTP wiring ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/live') {
      res.end(JSON.stringify(await getLive()));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
      res.end(JSON.stringify(await getHistory(days)));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err: any) {
    res.writeHead(typeof err?.status === 'number' ? err.status : 500);
    res.end(JSON.stringify({ error: err?.message ?? 'Internal error' }));
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    // Signal readiness to the host — this JSON line is required
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
