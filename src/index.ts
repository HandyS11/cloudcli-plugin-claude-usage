/**
 * Claude Usage plugin — module entry point.
 * Live plan-limit gauges + 30-day token/cost history.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Response shapes (mirror server.ts output; do not import server code) ─

interface TokenCounts { input: number; output: number; cacheCreate: number; cacheRead: number }
interface LiveLimit { kind: string; label: string; percent: number; severity: string; resetsAt: string | null; model: string | null }
interface LiveData {
  plan: string | null; tier: string | null; limits: LiveLimit[];
  fetchedAt: number; stale: boolean; error: string | null; retryAt: number | null;
}

interface HistoryData {
  daily: { date: string; tokens: TokenCounts; cost: number }[];
  byModel: { model: string; tokens: TokenCounts; cost: number | null }[];
  byProject: { project: string; tokens: TokenCounts; cost: number | null }[];
  totals: { tokens: TokenCounts; cost: number; sessions: number; messages: number };
}

// The usage endpoint rate-limits after a handful of calls and the limit is shared
// with Claude Code's own /usage screen, so poll it rarely. The server caches for
// the same interval and backs off on 429, so the refresh button is safe too.
const LIVE_POLL_MS = 5 * 60_000;
const TICK_MS = 60_000;

// ── Theme (follows the CloudCLI host) ───────────────────────────────────
// The plugin is mounted straight into the host page, so host CSS variables
// and fonts are inherited. Every colour reads the host variable, with a
// fallback for hosts that do not define it. Variables are HSL triplets.

const SANS = "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** Corner radius derived from the host's --radius. */
function radius(minusPx = 0): string {
  return minusPx ? `calc(var(--radius, 0.625rem) - ${minusPx}px)` : 'var(--radius, 0.625rem)';
}

const FALLBACKS = {
  light: {
    background: '60 14.3% 98.6%', foreground: '60 2.6% 7.6%', card: '0 0% 100%',
    primary: '15.5 58.2% 43.1%', muted: '60 3.2% 93.9%', accent: '48 12.2% 92%', 'muted-foreground': '50 2.9% 40.8%',
    border: '60 1.7% 88.4%', input: '60 1.5% 87.3%', ring: '15.1 55.6% 52.4%', destructive: '4.1 59.1% 44.1%',
  },
  dark: {
    background: '0 0% 8.2%', foreground: '45 11.8% 93.3%', card: '60 1.6% 12.4%',
    primary: '15.2 64.9% 63.1%', muted: '0 0% 12.9%', accent: '0 1.2% 16.7%', 'muted-foreground': '45 3.6% 56.1%',
    border: '0 1.2% 15.9%', input: '30 1.9% 21.2%', ring: '15.2 64.9% 63.1%', destructive: '9.9 72.5% 67.3%',
  },
} as const;

type HostVar = keyof typeof FALLBACKS.light;

interface ThemeColors { bg: string; surface: string; border: string; track: string; text: string; muted: string; accent: string; hover: string; ring: string; ok: string; warn: string; bad: string }

function themeColors(dark: boolean): ThemeColors {
  const fb = FALLBACKS[dark ? 'dark' : 'light'];
  const v = (name: HostVar): string => `hsl(var(--${name}, ${fb[name]}))`;
  return {
    bg: v('background'),
    surface: v('card'),
    border: v('border'),
    track: v('input'),
    text: v('foreground'),
    muted: v('muted-foreground'),
    accent: v('primary'),
    hover: v('accent'),
    ring: v('ring'),
    // The host has no success/warning tokens; these are tuned for >= 4.5:1
    // on --card and --background in each mode.
    ok: dark ? 'hsl(142 42% 58%)' : 'hsl(142 52% 30%)',
    warn: dark ? 'hsl(38 82% 62%)' : 'hsl(32 92% 33%)',
    bad: v('destructive'),
  };
}

function sevColor(c: ThemeColors, severity: string, percent: number): string {
  if (percent >= 90 || (severity !== 'normal' && severity !== 'warning')) return c.bad;
  if (percent >= 70 || severity === 'warning') return c.warn;
  return c.ok;
}

// ── Formatting helpers ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

function totalOf(t: TokenCounts): number {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

function resetsIn(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

// ── Section renderers ───────────────────────────────────────────────────

function card(c: ThemeColors, title: string, body: string): string {
  return `
    <div style="background:${c.surface};border:1px solid ${c.border};border-radius:${radius()};padding:18px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;font-size:0.68rem;font-weight:500;color:${c.muted};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px">${title}</div>
      ${body}
    </div>`;
}

function errorNote(c: ThemeColors, msg: string): string {
  return `<div style="font-size:0.8rem;color:${c.warn}">⚠ ${esc(msg)}</div>`;
}

function planBadge(c: ThemeColors, live: LiveData | null): string {
  if (!live?.plan) return '';
  const tier = live.tier ? ` · ${esc(live.tier.replace(/^default_claude_/, ''))}` : '';
  return `<span style="flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:600;line-height:1.4;border:1px solid ${c.border};border-radius:${radius(2)};padding:1px 8px;color:${c.muted}">${esc(live.plan)}${tier}</span>`;
}

function renderLive(c: ThemeColors, live: LiveData | null, error: string | null): string {
  const updated = live
    ? `<span style="font-family:${MONO};font-size:0.65rem;font-weight:400;letter-spacing:0;text-transform:none;color:${c.muted};margin-left:8px">updated ${ago(Date.now() - live.fetchedAt)}</span>`
    : '';
  let body: string;
  if (error) {
    body = errorNote(c, error);
  } else if (!live || live.limits.length === 0) {
    body = `<div style="font-size:0.75rem;color:${c.muted}">No limit data available.</div>`;
  } else {
    if (live.stale && live.error) {
      body = errorNote(c, `${live.error} Showing last reading from ${ago(Date.now() - live.fetchedAt)}.`)
        + `<div style="height:10px"></div>`;
    } else {
      body = '';
    }
    body += live.limits.map((l) => {
      const color = sevColor(c, l.severity, l.percent);
      const pct = Math.max(0, Math.min(100, l.percent));
      return `
        <div class="cu-gauge">
          <div style="display:flex;flex-wrap:wrap;justify-content:space-between;column-gap:8px;row-gap:2px;font-size:0.8rem;margin-bottom:6px">
            <span>${esc(l.label)}</span>
            <span style="font-family:${MONO};font-size:0.72rem;color:${c.muted}">${l.percent}% · ${resetsIn(l.resetsAt)}</span>
          </div>
          <div style="height:6px;background:${c.track};border-radius:${radius(6)};overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:${radius(6)};transition:width 0.4s"></div>
          </div>
        </div>`;
    }).join('');
  }
  return card(c, `plan limits ${updated}`, body);
}

function renderChart(c: ThemeColors, daily: HistoryData['daily']): string {
  const max = Math.max(1, ...daily.map((d) => totalOf(d.tokens)));
  const bars = daily.map((d, i) => {
    const h = Math.round((totalOf(d.tokens) / max) * 100);
    const label = `${d.date}: ${fmtTokens(totalOf(d.tokens))} tokens · ${fmtCost(d.cost)}`;
    return `<div title="${label}" style="flex:1;display:flex;align-items:flex-end;height:90px">
      <div style="width:100%;height:${Math.max(h, totalOf(d.tokens) > 0 ? 3 : 0)}%;background:${c.accent};opacity:${0.45 + 0.55 * (i / daily.length)};border-radius:${radius(8)} ${radius(8)} 0 0"></div>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:2px;align-items:flex-end">${bars}</div>
    <div style="display:flex;justify-content:space-between;font-family:${MONO};font-size:0.65rem;color:${c.muted};margin-top:6px">
      <span>${daily[0]?.date ?? ''}</span><span>${daily[daily.length - 1]?.date ?? ''}</span>
    </div>`;
}

function renderTable(c: ThemeColors, rows: [string, TokenCounts, number | null][]): string {
  if (rows.length === 0) return `<div style="font-size:0.75rem;color:${c.muted}">No data.</div>`;
  return rows.map(([name, tokens, cost]) => `
    <div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid ${c.border};font-size:0.78rem">
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;opacity:0.8" title="${esc(name)}">${esc(name)}</div>
      <div style="flex-shrink:0;font-family:${MONO};font-size:0.72rem;color:${c.muted}">${fmtTokens(totalOf(tokens))}</div>
      <div style="flex-shrink:0;width:70px;text-align:right;font-family:${MONO};font-size:0.72rem;color:${c.accent}">${fmtCost(cost)}</div>
    </div>`).join('');
}

function renderHistory(c: ThemeColors, history: HistoryData | null, error: string | null): string {
  if (error) return card(c, 'usage history (30 days)', errorNote(c, error));
  if (!history) return card(c, 'usage history (30 days)', `<div style="font-size:0.75rem;color:${c.muted}">Loading…</div>`);
  if (history.totals.messages === 0) {
    return card(c, 'usage history (30 days)', `<div style="font-size:0.75rem;color:${c.muted}">No Claude Code activity found in the last 30 days.</div>`);
  }
  const t = history.totals;
  const stats: [string, string][] = [
    ['total tokens', fmtTokens(totalOf(t.tokens))],
    ['output tokens', fmtTokens(t.tokens.output)],
    ['est. cost', fmtCost(t.cost)],
    ['sessions', String(t.sessions)],
  ];
  const statCards = `
    <div class="cu-stats">
      ${stats.map(([label, val]) => `
        <div style="background:${c.surface};border:1px solid ${c.border};border-radius:${radius()};padding:14px">
          <div class="cu-stat-value" style="font-family:${MONO};font-weight:600;letter-spacing:-0.03em">${val}</div>
          <div style="font-size:0.68rem;font-weight:500;color:${c.muted};margin-top:4px;letter-spacing:0.08em;text-transform:uppercase">${label}</div>
        </div>`).join('')}
    </div>`;
  return `
    ${statCards}
    ${card(c, 'daily tokens (30 days)', renderChart(c, history.daily))}
    <div class="cu-split">
      ${card(c, 'by model', renderTable(c, history.byModel.map((m) => [m.model, m.tokens, m.cost])))}
      ${card(c, 'by project', renderTable(c, history.byProject.slice(0, 10).map((p) => [p.project, p.tokens, p.cost])))}
    </div>`;
}

// ── Mount / Unmount ─────────────────────────────────────────────────────

interface State {
  live: LiveData | null;
  liveError: string | null;
  history: HistoryData | null;
  historyError: string | null;
}

// Lucide-style glyphs drawn like the host's built-in tab headers.
const GAUGE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20a8 8 0 1 1 8-8"/><path d="M12 12l4-4"/><path d="M12 20v.01"/><path d="M20 12h.01"/><path d="M4 12h.01"/><path d="M6.3 6.3l.01.01"/></svg>';
const REFRESH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';

// Layout and interaction states that inline styles can't express. Colours
// come from --cu-* properties set inline so they follow the host theme.
// Breakpoints are container queries: the panel is narrower than the screen
// whenever the host sidebar is open.
const STYLES = `
  .cu-root { container-type: inline-size; }
  .cu-body { padding: 20px 24px 24px; }
  .cu-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
  .cu-stat-value { font-size: 1.35rem; }
  .cu-gauge + .cu-gauge { margin-top: 14px; }
  .cu-split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 10px; }
  .cu-refresh { transition: background 0.15s, color 0.15s; }
  .cu-refresh:disabled { opacity: 0.5; cursor: default; }
  .cu-refresh:focus-visible { outline: 1px solid var(--cu-ring); outline-offset: 0; }
  .cu-spin { animation: cu-spin 1s linear infinite; }
  @keyframes cu-spin { to { transform: rotate(360deg); } }
  @media (hover: hover) {
    .cu-refresh:not(:disabled):hover { background: var(--cu-hover-bg) !important; color: var(--cu-hover-fg) !important; }
  }
  @container (max-width: 720px) {
    .cu-split { grid-template-columns: minmax(0, 1fr); }
  }
  @container (max-width: 560px) {
    .cu-body { padding: 16px; }
    .cu-header { padding-left: 16px !important; padding-right: 12px !important; }
    .cu-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cu-stat-value { font-size: 1.2rem; }
  }
`;

interface State {
  live: LiveData | null;
  liveError: string | null;
  history: HistoryData | null;
  historyError: string | null;
  loading: boolean;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  root.className = 'cu-root';
  Object.assign(root.style, {
    height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', fontFamily: SANS,
  });
  // The header stays put; only the body scrolls, and it is reused across
  // renders so its scroll position survives the 60s refresh.
  const header = document.createElement('div');
  header.className = 'cu-header';
  Object.assign(header.style, {
    flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', padding: '12px 16px',
  });
  const body = document.createElement('div');
  body.className = 'cu-body';
  Object.assign(body.style, { flex: '1', minHeight: '0', overflowY: 'auto', boxSizing: 'border-box' });
  root.append(header, body);
  container.appendChild(root);

  const style = document.createElement('style');
  style.textContent = STYLES;
  container.appendChild(style);

  const state: State = { live: null, liveError: null, history: null, historyError: null, loading: false };

  function render(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    header.style.borderBottom = `1px solid ${c.border}`;
    header.innerHTML = `
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <span style="display:flex;flex-shrink:0;color:${c.accent}">${GAUGE_ICON}</span>
          <h3 style="margin:0;flex-shrink:0;font-size:0.875rem;font-weight:600;line-height:1.25rem">Claude Usage</h3>
          ${planBadge(c, state.live)}
        </div>
        <p style="margin:2px 0 0;font-size:0.75rem;line-height:1rem;color:${c.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Plan limits and 30-day token history</p>
      </div>
      <button id="cu-refresh" class="cu-refresh" type="button" title="Refresh" aria-label="Refresh"${state.loading ? ' disabled' : ''}
        style="--cu-ring:${c.ring};--cu-hover-bg:${c.hover};--cu-hover-fg:${c.text};flex-shrink:0;display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;background:transparent;border:0;color:${c.text};border-radius:${radius(2)};cursor:pointer">
        <span style="display:flex"${state.loading ? ' class="cu-spin"' : ''}>${REFRESH_ICON}</span>
      </button>
    `;
    body.innerHTML = `
      ${renderLive(c, state.live, state.liveError)}
      ${renderHistory(c, state.history, state.historyError)}
    `;
    header.querySelector('#cu-refresh')?.addEventListener('click', () => void load(true));
  }

  async function loadLive(): Promise<void> {
    try {
      state.live = (await api.rpc('GET', 'live')) as LiveData;
      state.liveError = null;
    } catch (err) {
      state.live = null;
      state.liveError = (err as Error).message || 'Live usage unavailable.';
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      state.history = (await api.rpc('GET', 'history?days=30')) as HistoryData;
      state.historyError = null;
    } catch (err) {
      state.history = null;
      state.historyError = (err as Error).message || 'History unavailable.';
    }
  }

  async function load(refreshHistory: boolean): Promise<void> {
    // Only full loads (first load, refresh button) show the spinner; the
    // background poll updates quietly.
    if (refreshHistory) {
      state.loading = true;
      render(api.context);
    }
    // Sections load and fail independently.
    await Promise.all([loadLive(), refreshHistory || !state.history ? loadHistory() : Promise.resolve()]);
    state.loading = false;
    render(api.context);
  }

  render(api.context);
  void load(true);

  // Live gauges re-fetch every 5 minutes; countdown / "updated" text re-renders
  // every minute without touching the network.
  const poll = window.setInterval(() => void load(false), LIVE_POLL_MS);
  const tick = window.setInterval(() => render(api.context), TICK_MS);
  const unsubscribe = api.onContextChange((ctx) => render(ctx));

  (container as any)._cuCleanup = () => {
    window.clearInterval(poll);
    window.clearInterval(tick);
    unsubscribe();
  };
}

export function unmount(container: HTMLElement): void {
  (container as any)._cuCleanup?.();
  delete (container as any)._cuCleanup;
  container.innerHTML = '';
}
