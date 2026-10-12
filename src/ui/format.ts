// Formatting helpers shared by popup and options.
import type { Account, UsageLimit, UsageMetric, UsageWindow } from '../shared/types';
import { serviceOf } from '../shared/types';

export const METRIC_LABELS: Record<UsageMetric, string> = {
  maxAny: 'Any limit (max)',
  fiveHour: '5-hour',
  sevenDay: 'Weekly (all)',
  sevenDayOpus: 'Weekly Opus',
  sevenDaySonnet: 'Weekly Sonnet',
};

/** All metrics selectable in rules / badge settings. */
export const METRIC_ORDER: UsageMetric[] = ['maxAny', 'fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet'];

/** Metrics that map to a dedicated window on UsageSnapshot (bars in the popup). */
const BAR_METRICS = ['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet'] as const;
type BarMetric = (typeof BAR_METRICS)[number];

/** Format a future reset instant as "2h 14m", "3d 5h" or "just now". */
export function formatResetAt(resetsAt: string | null, nowMs: number = Date.now()): string {
  if (!resetsAt) return 'not started';
  const diff = new Date(resetsAt).getTime() - nowMs;
  if (Number.isNaN(diff)) return 'unknown';
  if (diff <= 0) return 'any moment';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return minutes < 1 ? 'under a minute' : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/** Usage windows present on an account, in display order. `includeAll` forces 5h + 7d rows even when null. */
export function usageBarsFor(account: Account, includeAll: boolean): UsageWindowWithMetric[] {
  if (!account.usage) return [];
  const out: UsageWindowWithMetric[] = [];
  for (const metric of BAR_METRICS) {
    const window = account.usage[metric];
    if (window) out.push({ metric, window });
    else if (includeAll && (metric === 'fiveHour' || metric === 'sevenDay')) out.push({ metric, window: null });
  }
  return out;
}

export interface UsageWindowWithMetric {
  metric: BarMetric;
  window: UsageWindow | null;
}

/** Severity of a utilization percent, used for bar color. */
export function severityOf(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90) return 'danger';
  if (percent >= 60) return 'warn';
  return 'ok';
}

/** True when the snapshot is older than twice the poll interval. */
export function isStale(account: Account, pollIntervalMinutes: number, nowMs: number = Date.now()): boolean {
  if (!account.usage) return false;
  return nowMs - account.usage.fetchedAt > pollIntervalMinutes * 2 * 60 * 1000;
}

/** One renderable usage bar, from either the generic `limits` list or a legacy window. */
export interface DisplayBar {
  key: string;
  label: string;
  percent: number | null;
  resetsAt: string | null;
}

/** Human label for a claude.ai limit entry: "Session (5h)", "Weekly", "Weekly · Opus". */
export function limitLabel(limit: UsageLimit): string {
  if (limit.kind === 'session' || limit.group === 'session') return 'Session (5h)';
  const base = limit.group === 'weekly' || limit.kind.startsWith('weekly') ? 'Weekly' : capitalize(limit.group || limit.kind);
  return limit.scopeLabel ? `${base} · ${limit.scopeLabel}` : base;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, ' ') : 'Limit';
}

/**
 * Bars to show for an account. Prefers the generic `limits` list (the reliable source: legacy
 * windows such as `seven_day` are often null), falling back to the legacy windows.
 * `includeAll` adds empty 5h + weekly rows when nothing is known, so the layout stays stable.
 */
export function displayBars(account: Account, includeAll: boolean): DisplayBar[] {
  const usage = account.usage;
  if (serviceOf(account) === 'platform') return []; // Platform: spend line only, no bars
  if (usage && usage.limits.length > 0) {
    return usage.limits.map((l, i) => ({
      key: `limit-${i}`,
      label: limitLabel(l),
      percent: l.percent,
      resetsAt: l.resetsAt,
    }));
  }
  return usageBarsFor(account, includeAll).map(({ metric, window }) => ({
    key: metric,
    label: METRIC_LABELS[metric],
    percent: window ? window.utilization : null,
    resetsAt: window ? window.resetsAt : null,
  }));
}

/** "$210.50" from cents; null → "—". */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** "$210.50 spent this month" for a Platform account, or null when spend is unknown. */
export function platformSpendText(account: Account): string | null {
  const cents = account.usage?.billing?.spendCents;
  return typeof cents === 'number' ? `${formatCents(cents)} spent this month` : null;
}

/** Highest known usage percent across all limits and windows, or null when unknown. */
export function primaryPercent(account: Account): number | null {
  const values = displayBars(account, false)
    .map((b) => b.percent)
    .filter((p): p is number => typeof p === 'number');
  return values.length > 0 ? Math.max(...values) : null;
}

export function accountInitial(account: Account): string {
  const base = account.label?.trim() || account.displayName?.trim() || account.email.trim();
  return (base[0] ?? '?').toUpperCase();
}

/** Curated palette for account colors (kept small on purpose). */
export const ACCOUNT_COLOR_PALETTE = [
  '#d97757', // terracotta
  '#c2577a',
  '#a05cb4',
  '#5b7bd5',
  '#2f8f8f',
  '#3d8546',
  '#8a8f3a',
  '#b3752a',
  '#7a6f66',
];

export function defaultAccountColor(index: number): string {
  return ACCOUNT_COLOR_PALETTE[index % ACCOUNT_COLOR_PALETTE.length] ?? '#d97757';
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Download a UTF-8 text file from a document page. */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
