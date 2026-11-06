// The credentials file only carries internal plan codes (`max`,
// `default_claude_max_20x`), which Anthropic keeps when it renames plans.
// The marketing name ("Ultra") is only on the OAuth profile endpoint, so it is
// fetched separately and cached for a long time: plans rarely change.

/** How long a plan name is reused for the same access token. */
export const PROFILE_CACHE_MS = 60 * 60_000;
/** How soon a failed profile fetch is retried. */
export const PROFILE_RETRY_MS = 5 * 60_000;

/** `organization.plan_display_name` from the profile response, or null. */
export function parsePlanName(profile: unknown): string | null {
  const name = (profile as any)?.organization?.plan_display_name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

/**
 * Caches the plan display name. Never throws: on failure it keeps the last
 * known name (or null), so the badge falls back to the raw plan codes.
 */
export class PlanNameCache {
  private name: string | null = null;
  private token: string | null = null;
  private nextAllowedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly fetchProfile: (accessToken: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(accessToken: string): Promise<string | null> {
    // A new token means a token refresh or a fresh login (maybe a new plan).
    if (!this.inflight && (accessToken !== this.token || this.now() >= this.nextAllowedAt)) {
      this.inflight = this.refresh(accessToken).finally(() => { this.inflight = null; });
    }
    await this.inflight;
    return this.name;
  }

  private async refresh(accessToken: string): Promise<void> {
    const now = this.now();
    this.token = accessToken;
    let name: string | null = null;
    try {
      name = parsePlanName(await this.fetchProfile(accessToken));
    } catch {
      // Cosmetic only: fall through and retry later.
    }
    if (name) this.name = name;
    this.nextAllowedAt = now + (name ? PROFILE_CACHE_MS : PROFILE_RETRY_MS);
  }
}
