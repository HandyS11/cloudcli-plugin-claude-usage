import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseTranscriptLine, projectLabel, SessionEntries, UsageEntry } from './history.js';

// Per-file parse cache keyed by mtime, so repeated polls only re-read changed files.
const fileCache = new Map<string, { mtimeMs: number; entries: UsageEntry[] }>();

// Streamed rather than read whole: a cold scan can cover hundreds of MB, and
// blocking the event loop that long makes the /live request running beside it
// hit its own timeout even though the endpoint has already answered.
async function readSessionFile(file: string): Promise<UsageEntry[]> {
  const { mtimeMs } = await fs.promises.stat(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
  const entries: UsageEntry[] = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  fileCache.set(file, { mtimeMs, entries });
  return entries;
}

async function scanProjects(projectsDir: string): Promise<SessionEntries[]> {
  const sessions: SessionEntries[] = [];
  let dirs: fs.Dirent[] = [];
  try {
    dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    // no transcripts at all — aggregate over nothing, frontend shows empty state
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const project = projectLabel(dir.name);
    let files: string[];
    try {
      files = (await fs.promises.readdir(path.join(projectsDir, dir.name))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        sessions.push({ project, entries: await readSessionFile(path.join(projectsDir, dir.name, f)) });
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return sessions;
}

const inflight = new Map<string, Promise<SessionEntries[]>>();

/** Read every session under projectsDir. Concurrent callers share one scan. */
export function loadSessions(projectsDir: string): Promise<SessionEntries[]> {
  let scan = inflight.get(projectsDir);
  if (!scan) {
    scan = scanProjects(projectsDir).finally(() => { inflight.delete(projectsDir); });
    inflight.set(projectsDir, scan);
  }
  return scan;
}
