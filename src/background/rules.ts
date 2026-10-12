// Pure rules engine: no chrome.* APIs here, so this is fully unit-testable.
//
// Schedule condition format: `cron` is a plain daily "HH:MM" in local time (24h, zero-padded, e.g.
// "09:30") — we deliberately do not support full cron syntax, and a malformed/out-of-range string
// never matches. A schedule rule fires on the first poll tick at or after today's HH:MM, and won't
// fire again until a poll lands at or after *tomorrow's* HH:MM — tracked via `lastRuleFire[rule.id]`
// rather than the generic `cooldownMinutes` gate, so it's independent of the poll interval.
//
// `GLOBAL_SWITCH_GAP_KEY` in `lastRuleFire` tracks the last time ANY rule fired, enforcing
// `GLOBAL_MIN_SWITCH_GAP_MINUTES` between automatic switches regardless of which rule caused them —
// this is what stops two rules (or a rule firing back-to-back near a threshold) from ping-ponging
// the active account every poll tick.
import type { Account, RuleCondition, RuleTarget, Settings, SwitchRule, UsageMetric, UsageSnapshot } from '../shared/types';
import { serviceOf } from '../shared/types';

export type { Account, Settings, SwitchRule, UsageSnapshot } from '../shared/types';

export interface RuleEngineInput {
  accounts: Account[];
  activeAccountId: string | null;
  rules: SwitchRule[];
  settings: Settings;
  lastRuleFire: Record<string, number>;
}

export interface RuleFireResult {
  ruleId: string;
  switchTo: string;
  confirm: boolean;
}

/** Synthetic key in `lastRuleFire` tracking the last automatic switch caused by any rule. */
export const GLOBAL_SWITCH_GAP_KEY = '__global__';
export const GLOBAL_MIN_SWITCH_GAP_MINUTES = 10;

const SCHEDULE_CRON_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Highest percent across every `limits` entry plus the four legacy windows, or null if there is no data. */
function maxAnyValue(usage: UsageSnapshot): number | null {
  const values: number[] = [];
  for (const limit of usage.limits) values.push(limit.percent);
  for (const window of [usage.fiveHour, usage.sevenDay, usage.sevenDayOpus, usage.sevenDaySonnet]) {
    if (window) values.push(window.utilization);
  }
  return values.length === 0 ? null : Math.max(...values);
}

export function getMetricValue(usage: UsageSnapshot | null, metric: UsageMetric): number | null {
  if (!usage) return null;
  if (metric === 'maxAny') return maxAnyValue(usage);
  const window =
    metric === 'fiveHour' ? usage.fiveHour : metric === 'sevenDay' ? usage.sevenDay : metric === 'sevenDayOpus' ? usage.sevenDayOpus : usage.sevenDaySonnet;
  return window ? window.utilization : null;
}

/** True when any active `limits` entry, or any legacy window, is at (or past) 100%. */
export function isLimitReached(usage: UsageSnapshot | null): boolean {
  if (!usage) return false;
  if (usage.limits.some((limit) => limit.isActive && limit.percent >= 100)) return true;
  return [usage.fiveHour, usage.sevenDay, usage.sevenDayOpus, usage.sevenDaySonnet].some((w) => w !== null && w.utilization >= 100);
}

function conditionMetric(condition: RuleCondition): UsageMetric {
  return condition.type === 'usageAbove' ? condition.metric : 'maxAny';
}

function conditionMatches(condition: RuleCondition, activeAccount: Account | undefined, now: number, lastFire: number | undefined): boolean {
  switch (condition.type) {
    case 'usageAbove': {
      const value = getMetricValue(activeAccount?.usage ?? null, condition.metric);
      return value !== null && value > condition.percent;
    }
    case 'limitReached':
      return isLimitReached(activeAccount?.usage ?? null);
    case 'schedule': {
      if (!SCHEDULE_CRON_PATTERN.test(condition.cron)) return false;
      const [hh, mm] = condition.cron.split(':').map(Number);
      const scheduledToday = new Date(now);
      scheduledToday.setHours(hh!, mm!, 0, 0);
      const scheduledTime = scheduledToday.getTime();
      if (now < scheduledTime) return false;
      return lastFire === undefined || lastFire < scheduledTime;
    }
  }
}

/** The effective `targetMaxPercent`: explicit if set, else defaulted to the triggering condition's
 * own percent for `usageAbove` rules (so a switch never lands on an account that's just as
 * overloaded as the one being switched away from — the root cause of ping-pong switching). */
function effectiveTargetMaxPercent(rule: SwitchRule): number | undefined {
  if (rule.targetMaxPercent !== undefined) return rule.targetMaxPercent;
  return rule.condition.type === 'usageAbove' ? rule.condition.percent : undefined;
}

function isEligibleTarget(account: Account, activeAccountId: string | null, rule: SwitchRule, metric: UsageMetric): boolean {
  if (account.id === activeAccountId) return false;
  if (account.paused) return false;
  if (account.sessionExpired) return false;
  if (isLimitReached(account.usage)) return false; // never switch into an account that's already maxed out
  const maxPercent = effectiveTargetMaxPercent(rule);
  if (maxPercent !== undefined) {
    const value = getMetricValue(account.usage, metric);
    if (value === null) return false; // unknown usage — don't gamble on it when there's a cap to respect
    if (value >= maxPercent) return false;
  }
  return true;
}

function orderedAccountIds(accounts: Account[], accountOrder: string[]): string[] {
  const known = new Set(accounts.map((a) => a.id));
  const ordered = accountOrder.filter((id) => known.has(id));
  for (const a of accounts) if (!ordered.includes(a.id)) ordered.push(a.id);
  return ordered;
}

function resolveTarget(target: RuleTarget, rule: SwitchRule, input: RuleEngineInput): string | null {
  const metric = target.type === 'lowestUsage' ? target.metric : conditionMetric(rule.condition);
  const byId = new Map(input.accounts.map((a) => [a.id, a] as const));
  const eligible = (id: string): Account | null => {
    const account = byId.get(id);
    return account && isEligibleTarget(account, input.activeAccountId, rule, metric) ? account : null;
  };

  switch (target.type) {
    case 'specific':
      return eligible(target.accountId)?.id ?? null;

    case 'priority': {
      const order = orderedAccountIds(input.accounts, input.settings.accountOrder);
      for (const id of order) {
        const account = eligible(id);
        if (account) return account.id;
      }
      return null;
    }

    case 'next': {
      const order = orderedAccountIds(input.accounts, input.settings.accountOrder);
      const activeIndex = input.activeAccountId ? order.indexOf(input.activeAccountId) : -1;
      const start = activeIndex === -1 ? 0 : activeIndex + 1;
      for (let i = 0; i < order.length; i++) {
        const id = order[(start + i) % order.length]!;
        const account = eligible(id);
        if (account) return account.id;
      }
      return null;
    }

    case 'lowestUsage': {
      let best: { id: string; value: number } | null = null;
      for (const account of input.accounts) {
        if (!eligible(account.id)) continue;
        const value = getMetricValue(account.usage, target.metric);
        if (value === null) continue; // unknown usage is not a safe pick
        if (best === null || value < best.value) best = { id: account.id, value };
      }
      return best?.id ?? null;
    }
  }
}

/**
 * Plain round-robin: the next account after `activeAccountId` in `accountOrder` (accounts missing
 * from the order are appended at the end) that isn't paused or session-expired. Used for the manual
 * "switch to next account" shortcut/message, independent of any rule.
 */
export function nextEligibleAccount(accounts: Account[], activeAccountId: string | null, accountOrder: string[]): string | null {
  const order = orderedAccountIds(accounts, accountOrder);
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  const activeIndex = activeAccountId ? order.indexOf(activeAccountId) : -1;
  const start = activeIndex === -1 ? 0 : activeIndex + 1;
  for (let i = 0; i < order.length; i++) {
    const account = byId.get(order[(start + i) % order.length]!);
    if (account && account.id !== activeAccountId && !account.paused && !account.sessionExpired) return account.id;
  }
  return null;
}

/**
 * Evaluates rules in order and returns the first one that both matches its condition and has an
 * eligible switch target. A rule whose condition matches but has no eligible target does not block
 * evaluation — it is skipped so later rules still get a chance.
 */
export function evaluateRules(rawInput: RuleEngineInput, now: number): RuleFireResult | null {
  if (!rawInput.settings.autoSwitchEnabled) return null;

  const globalLastFire = rawInput.lastRuleFire[GLOBAL_SWITCH_GAP_KEY];
  if (globalLastFire !== undefined && now - globalLastFire < GLOBAL_MIN_SWITCH_GAP_MINUTES * 60_000) return null;

  // The rules engine (and, separately, the toolbar badge) is claude.ai-only: platform accounts are
  // never an active account or a switch target here, regardless of what the caller passes in.
  const input: RuleEngineInput = { ...rawInput, accounts: rawInput.accounts.filter((a) => serviceOf(a) === 'claude') };
  const activeAccount = input.accounts.find((a) => a.id === input.activeAccountId);

  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    const lastFire = input.lastRuleFire[rule.id];
    if (lastFire !== undefined && now - lastFire < rule.cooldownMinutes * 60_000) continue;
    if (!conditionMatches(rule.condition, activeAccount, now, lastFire)) continue;

    const switchTo = resolveTarget(rule.target, rule, input);
    if (switchTo === null) continue;

    return { ruleId: rule.id, switchTo, confirm: rule.confirm };
  }

  return null;
}

export interface ValueCrossingsOptions {
  /** Default `true` (claude.ai's usage-percent behavior): a missing previous value is treated as
   * below every threshold, so a first read that's already high still notifies. Pass `false` (used
   * for platform spend) to instead treat a missing previous value as "no baseline yet" and report no
   * crossings — the first observation just establishes the baseline silently. */
  notifyOnUnknownPrev?: boolean;
}

/**
 * Returns the `thresholds` crossed upward (prev < threshold <= next) for any numeric value — usage
 * percent, spend in cents, whatever.
 */
export function valueCrossings(prevValue: number | null, nextValue: number | null, thresholds: number[], options: ValueCrossingsOptions = {}): number[] {
  const { notifyOnUnknownPrev = true } = options;
  if (nextValue === null) return [];
  if (prevValue === null && !notifyOnUnknownPrev) return [];
  const prev = prevValue ?? -Infinity;
  return thresholds.filter((threshold) => prev < threshold && nextValue >= threshold).sort((a, b) => a - b);
}

/** `valueCrossings` specialized to the `maxAny` usage percent metric. */
export function thresholdCrossings(prev: UsageSnapshot | null, next: UsageSnapshot | null, notifyAtPercent: number[]): number[] {
  return valueCrossings(getMetricValue(prev, 'maxAny'), getMetricValue(next, 'maxAny'), notifyAtPercent);
}
