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
const SERIF = "'Source Serif 4', ui-serif, Georgia, serif";

/** Corner radius derived from the host's --radius. */
function radius(minusPx = 0): string {
  return minusPx ? `calc(var(--radius, 0.625rem) - ${minusPx}px)` : 'var(--radius, 0.625rem)';
}

const FALLBACKS = {
  light: {
    background: '60 14% 99%', foreground: '60 3% 8%', card: '0 0% 100%',
    primary: '15 58% 43%', muted: '60 3% 94%', accent: '48 12% 92%', 'muted-foreground': '50 3% 41%',
    border: '60 2% 88%', input: '60 2% 87%', ring: '15 56% 52%', destructive: '4 59% 44%',
  },
  dark: {
    background: '0 0% 8%', foreground: '45 12% 93%', card: '60 2% 12%',
    primary: '15 65% 63%', muted: '0 0% 13%', accent: '0 1% 17%', 'muted-foreground': '45 4% 56%',
    border: '30 2% 18%', input: '30 2% 21%', ring: '15 65% 63%', destructive: '10 72% 67%',
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

function renderLive(c: ThemeColors, live: LiveData | null, error: string | null): string {
  const badge = live?.plan
    ? `<span style="font-family:${MONO};font-size:0.65rem;font-weight:400;letter-spacing:0;text-transform:none;border:1px solid ${c.border};border-radius:${radius(4)};padding:2px 8px;color:${c.muted}">${esc(live.plan)}${live.tier ? ` · ${esc(live.tier.replace(/^default_claude_/, ''))}` : ''}</span>`
    : '';
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
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:0.8rem;margin-bottom:6px">
            <span>${esc(l.label)}</span>
            <span style="font-family:${MONO};font-size:0.72rem;color:${c.muted}">${l.percent}% · ${resetsIn(l.resetsAt)}</span>
          </div>
          <div style="height:6px;background:${c.track};border-radius:${radius(6)};overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:${radius(6)};transition:width 0.4s"></div>
          </div>
        </div>`;
    }).join('');
  }
  return card(c, `plan limits ${badge}${updated}`, body);
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
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${stats.map(([label, val]) => `
        <div style="background:${c.surface};border:1px solid ${c.border};border-radius:${radius()};padding:14px">
          <div style="font-family:${MONO};font-size:1.35rem;font-weight:600;letter-spacing:-0.03em">${val}</div>
          <div style="font-size:0.68rem;font-weight:500;color:${c.muted};margin-top:4px;letter-spacing:0.08em;text-transform:uppercase">${label}</div>
        </div>`).join('')}
    </div>`;
  return `
    ${statCards}
    ${card(c, 'daily tokens (30 days)', renderChart(c, history.daily))}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
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

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    padding: '24px', fontFamily: SANS,
  });
  container.appendChild(root);

  // Interaction states can't be expressed inline; colours come from --cu-*
  // properties set on the element so they follow the host theme.
  const style = document.createElement('style');
  style.textContent = `
    .cu-refresh { transition: background 0.15s, color 0.15s; }
    .cu-refresh:hover { background: var(--cu-hover-bg) !important; color: var(--cu-hover-fg) !important; }
    .cu-refresh:focus-visible { outline: 2px solid var(--cu-ring); outline-offset: 2px; }
  `;
  container.appendChild(style);

  const state: State = { live: null, liveError: null, history: null, historyError: null };

  function render(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px">
        <div style="font-family:${SERIF};font-size:1.5rem;font-weight:600;letter-spacing:-0.01em">Claude Usage</div>
        <button id="cu-refresh" class="cu-refresh" style="--cu-ring:${c.ring};--cu-hover-bg:${c.hover};--cu-hover-fg:${c.text};padding:5px 12px;background:transparent;border:1px solid ${c.border};color:${c.muted};font-family:${SANS};font-size:0.75rem;border-radius:${radius(4)};cursor:pointer">↻ refresh</button>
      </div>
      ${renderLive(c, state.live, state.liveError)}
      ${renderHistory(c, state.history, state.historyError)}
    `;
    root.querySelector('#cu-refresh')?.addEventListener('click', () => void load(true));
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
    // Sections load and fail independently.
    await Promise.all([loadLive(), refreshHistory || !state.history ? loadHistory() : Promise.resolve()]);
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
