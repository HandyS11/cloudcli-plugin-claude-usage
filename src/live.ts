export interface LiveLimit {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  model: string | null;
}

export interface LiveData {
  plan: string | null;
  tier: string | null;
  limits: LiveLimit[];
}

export interface Credentials {
  accessToken: string;
  expired: boolean;
  plan: string | null;
  tier: string | null;
}

/** Read what we need from ~/.claude/.credentials.json. Never touches the refresh token. */
export function parseCredentials(json: unknown, nowMs: number): Credentials | null {
  const oauth = (json as any)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string') return null;
  return {
    accessToken: oauth.accessToken,
    expired: typeof oauth.expiresAt === 'number' && oauth.expiresAt < nowMs,
    plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    tier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
  };
}

const KIND_LABELS: Record<string, string> = {
  session: 'Session (5h)',
  weekly_all: 'Weekly (all models)',
  weekly_scoped: 'Weekly',
};

/** Defensive mapping of the (unofficial) usage endpoint response. */
export function normalizeUsage(raw: unknown, plan: string | null, tier: string | null): LiveData {
  const limits: LiveLimit[] = [];
  const rawLimits = (raw as any)?.limits;
  if (Array.isArray(rawLimits)) {
    for (const l of rawLimits) {
      if (typeof l?.kind !== 'string' || typeof l?.percent !== 'number') continue;
      const rawModel = l.scope?.model?.display_name;
      const model: string | null = typeof rawModel === 'string' && rawModel !== '' ? rawModel : null;
      const base = KIND_LABELS[l.kind] ?? l.kind;
      limits.push({
        kind: l.kind,
        label: model ? `${base} — ${model}` : base,
        percent: l.percent,
        severity: typeof l.severity === 'string' ? l.severity : 'normal',
        resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
        model,
      });
    }
  }
  return { plan, tier, limits };
}

// ── Caching + rate-limit backoff ────────────────────────────────────────
//
// The usage endpoint is rate-limited far more aggressively than normal API
// calls (a handful of requests per window, shared with Claude Code's own
// /usage screen). So: poll rarely, coalesce concurrent callers, and on 429
// back off and keep showing the last good reading instead of hammering it.

/** How long a successful reading is served without re-fetching. */
export const LIVE_CACHE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** What the server hands the cache after calling the endpoint. */
export interface UsageResponse {
  status: number;
  retryAfter: string | null;
  body: unknown;
  plan: string | null;
  tier: string | null;
}

export interface LiveResult extends LiveData {
  /** When the limits were last fetched successfully (ms epoch). */
  fetchedAt: number;
  /** True when the reading could not be refreshed and is older than LIVE_CACHE_MS. */
  stale: boolean;
  /** Why the last refresh failed, if it did. */
  error: string | null;
  /** When the next fetch is allowed, if we are backing off. */
  retryAt: number | null;
}

/** Delay before the n-th consecutive 429 is retried: 5m, 10m, 20m, 40m, 60m cap. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS);
}

/** Retry-After header → delay in ms, or null when absent, zero, past, or unparsable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : null;
  const at = Date.parse(header);
  return Number.isFinite(at) && at > nowMs ? at - nowMs : null;
}

function fmtWait(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  return min <= 1 ? '1 min' : `${min} min`;
}

export class LiveCache {
  private last: { at: number; data: LiveData } | null = null;
  private failure: { message: string; status: number; retryAt: number | null } | null = null;
  private failures429 = 0;
  private nextAllowedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly fetchUsage: () => Promise<UsageResponse>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<LiveResult> {
    if (this.inflight) {
      await this.inflight;
    } else if (this.now() >= this.nextAllowedAt) {
      this.inflight = this.refresh().finally(() => { this.inflight = null; });
      await this.inflight;
    }
    return this.result();
  }

  private async refresh(): Promise<void> {
    const now = this.now();
    // Whatever happens, don't call the endpoint again before the normal cadence;
    // a 429 pushes this further out below.
    this.nextAllowedAt = now + LIVE_CACHE_MS;
    let res: UsageResponse;
    try {
      res = await this.fetchUsage();
    } catch (err: any) {
      this.failure = { message: err?.message ?? 'Usage fetch failed.', status: typeof err?.status === 'number' ? err.status : 502, retryAt: null };
      return;
    }
    if (res.status === 429) {
      this.failures429++;
      const wait = parseRetryAfter(res.retryAfter, now) ?? backoffMs(this.failures429);
      this.failure = {
        message: `Usage endpoint returned HTTP 429 (rate limited) — retrying in ${fmtWait(wait)}.`,
        status: 429,
        retryAt: now + wait,
      };
      this.nextAllowedAt = now + wait;
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      this.failure = { message: `Usage endpoint returned HTTP ${res.status}.`, status: 502, retryAt: null };
      return;
    }
    this.failures429 = 0;
    this.failure = null;
    this.last = { at: now, data: normalizeUsage(res.body, res.plan, res.tier) };
  }

  private result(): LiveResult {
    if (!this.last) {
      const f = this.failure!;
      throw Object.assign(new Error(f.message), { status: f.status });
    }
    return {
      ...this.last.data,
      fetchedAt: this.last.at,
      stale: this.failure !== null,
      error: this.failure?.message ?? null,
      retryAt: this.failure?.retryAt ?? null,
    };
  }
}
