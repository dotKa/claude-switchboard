// Usage polling (chrome.alarms), the action badge, notifications, and running the rules engine
// against fresh data. Handles both services (claude.ai and platform.claude.com — see
// src/shared/types.ts's `SERVICES`), but the rules engine and badge stay claude.ai-only (rules.ts
// filters platform accounts out explicitly) per the platform-support scope decision.
import type { Account, Service, Settings, StorageSchema, UsageSnapshot } from '../shared/types';
import { SERVICES, serviceOf } from '../shared/types';
import { DnrUnavailableError, fetchPlatformUsage, fetchUsage, fetchUsageWithSessionOverride, SessionExpiredError } from './claudeApi';
import { evaluateRules, getMetricValue, GLOBAL_SWITCH_GAP_KEY, isLimitReached, nextEligibleAccount, thresholdCrossings, valueCrossings } from './rules';
import { hasPlatformPermission } from './permissions';
import { getCurrentSessionCookie, switchAccount } from './session';
import { loadState, updateState } from './storage';

export const POLL_ALARM_NAME = 'usagePoll';
const PENDING_CONFIRMATIONS_KEY = 'pendingConfirmations';
const DNR_UNAVAILABLE_MESSAGE = 'Usage for inactive accounts is unavailable in this browser.';
const AMBIGUOUS_OVERRIDE_ERROR_MESSAGE = 'Could not verify usage for this account right now.';

interface PendingConfirmation {
  ruleId: string;
  switchTo: string;
}

/** Clamps to a sane poll interval: a whole number of minutes, at least 1. */
export function sanitizePollInterval(minutes: number): number {
  return Math.max(1, Math.round(minutes));
}

/** Creates the poll alarm only if it's missing or its period actually changed — calling this on
 * every service-worker wake must not reset an already-correct alarm's schedule. */
export async function schedulePolling(periodMinutes: number): Promise<void> {
  const period = sanitizePollInterval(periodMinutes);
  const existing = await chrome.alarms.get(POLL_ALARM_NAME);
  if (existing && existing.periodInMinutes === period) return;
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: period });
}

// Once a declarativeNetRequest override attempt fails because the mechanism itself couldn't be
// installed (not just a 401), we treat that as a one-time capability probe: every SUBSEQUENT
// refreshUsage() call skips it entirely and just keeps accounts' last known snapshots. (Accounts
// fetched concurrently within the very same refreshUsage() batch may still race and both attempt it
// before either's failure is observed — this flag guarantees no new attempts after that, not
// mid-batch cancellation.) Module-level, so it resets on the next service-worker wake — an
// intentionally soft, re-triable "disable". Platform accounts never use this path at all (see
// `fetchUsageFor`), so it only ever applies to claude.ai's non-active-account polling.
let dnrOverrideDisabled = false;

interface UsageFetchResult {
  usage: UsageSnapshot | null;
  sessionExpired: boolean;
  usageError: string | undefined;
}

async function fetchUsageForClaude(account: Account, useActivePath: boolean, sessionKey: string | undefined): Promise<UsageFetchResult> {
  if (useActivePath) {
    try {
      return { usage: await fetchUsage(account.orgId), sessionExpired: false, usageError: undefined };
    } catch (err) {
      if (err instanceof SessionExpiredError) return { usage: account.usage, sessionExpired: true, usageError: undefined };
      return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: 'Could not refresh usage (network error).' };
    }
  }

  if (!sessionKey) return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: account.usageError };
  if (dnrOverrideDisabled) return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: DNR_UNAVAILABLE_MESSAGE };

  try {
    return { usage: await fetchUsageWithSessionOverride(account.orgId, sessionKey), sessionExpired: false, usageError: undefined };
  } catch (err) {
    if (err instanceof DnrUnavailableError) {
      dnrOverrideDisabled = true;
      return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: DNR_UNAVAILABLE_MESSAGE };
    }
    // A 401/403 here is ambiguous — it may just mean the header override didn't apply — so unlike
    // the active path, this NEVER flips `sessionExpired`. See claudeApi.ts's module doc comment.
    return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: AMBIGUOUS_OVERRIDE_ERROR_MESSAGE };
  }
}

/** A transient `current_spend` failure comes back from `fetchPlatformUsage` as `spendCents: null`
 * (see claudeApi.ts) — never let that null overwrite a previously known value, or the next
 * successful poll would look like a brand-new baseline and re-fire every threshold from scratch. */
function preserveSpendOnNull(prevUsage: UsageSnapshot | null, fetched: UsageSnapshot): UsageSnapshot {
  const prevSpend = prevUsage?.billing?.spendCents ?? null;
  if (!fetched.billing || fetched.billing.spendCents !== null || prevSpend === null) return fetched;
  return { ...fetched, billing: { ...fetched.billing, spendCents: prevSpend, spendResetsAt: prevUsage!.billing!.spendResetsAt } };
}

/** Platform support is account management, not usage polling: only the ACTIVE platform account is
 * ever refreshed (via a plain fetch, like claude.ai's active account), and only when the live
 * cookie actually matches its stored secret — there is no declarativeNetRequest override for
 * platform, so a mismatch just means "skip, keep the last known value" rather than a fallback. */
async function fetchUsageForPlatform(account: Account, useActivePath: boolean): Promise<UsageFetchResult> {
  if (!useActivePath) return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: account.usageError };
  // Without the optional platform.claude.com host permission, skip silently — same as having no
  // live cookie for the service — rather than letting the fetch below throw a confusing error.
  if (!(await hasPlatformPermission())) return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: account.usageError };
  try {
    const fetched = await fetchPlatformUsage(account.orgId, SERVICES.platform.origin);
    return { usage: preserveSpendOnNull(account.usage, fetched), sessionExpired: false, usageError: undefined };
  } catch (err) {
    if (err instanceof SessionExpiredError) return { usage: account.usage, sessionExpired: true, usageError: undefined };
    return { usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: 'Could not refresh spend (network error).' };
  }
}

async function fetchUsageFor(account: Account, useActivePath: boolean, sessionKey: string | undefined): Promise<UsageFetchResult> {
  return serviceOf(account) === 'platform' ? fetchUsageForPlatform(account, useActivePath) : fetchUsageForClaude(account, useActivePath, sessionKey);
}

function describeDrivingLimit(usage: UsageSnapshot): { label: string; resetsAt: string | null } | null {
  let best: { percent: number; label: string; resetsAt: string | null } | null = null;
  const consider = (percent: number, label: string, resetsAt: string | null) => {
    if (best === null || percent > best.percent) best = { percent, label, resetsAt };
  };
  for (const limit of usage.limits) consider(limit.percent, limit.scopeLabel ?? limit.group ?? limit.kind, limit.resetsAt);
  if (usage.fiveHour) consider(usage.fiveHour.utilization, '5-hour', usage.fiveHour.resetsAt);
  if (usage.sevenDay) consider(usage.sevenDay.utilization, 'weekly', usage.sevenDay.resetsAt);
  if (usage.sevenDayOpus) consider(usage.sevenDayOpus.utilization, 'weekly · Opus', usage.sevenDayOpus.resetsAt);
  if (usage.sevenDaySonnet) consider(usage.sevenDaySonnet.utilization, 'weekly · Sonnet', usage.sevenDaySonnet.resetsAt);
  return best;
}

function accountLabel(account: Account): string {
  return account.displayName || account.email || account.id;
}

function notify(id: string, title: string, message: string): void {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon-128.png', title, message });
}

function notifyThresholdCrossed(account: Account, percent: number, usage: UsageSnapshot | null): void {
  const driving = usage ? describeDrivingLimit(usage) : null;
  const resetText = driving?.resetsAt ? ` Resets ${new Date(driving.resetsAt).toLocaleString()}.` : '';
  notify(`switchboard-threshold:${account.id}:${percent}:${Date.now()}`, `${accountLabel(account)} is at ${percent}%+ usage`, `${driving?.label ?? 'Usage'} limit crossed ${percent}%.${resetText}`);
}

function notifyLimitReached(account: Account): void {
  notify(`switchboard-limit-reached:${account.id}:${Date.now()}`, `${accountLabel(account)} hit a usage limit`, 'A usage limit on this account is now at 100%.');
}

function notifySessionExpired(account: Account): void {
  notify(`switchboard-session-expired:${account.id}:${Date.now()}`, `${accountLabel(account)} is signed out`, 'This saved session has expired — log in again to keep using it.');
}

function notifySpendThresholdCrossed(account: Account, cents: number, usage: UsageSnapshot | null): void {
  const dollars = (cents / 100).toFixed(2);
  const resetsAt = usage?.billing?.spendResetsAt;
  const resetText = resetsAt ? ` Resets ${new Date(resetsAt).toLocaleString()}.` : '';
  notify(`switchboard-spend-threshold:${account.id}:${cents}:${Date.now()}`, `${accountLabel(account)} crossed $${dollars} spent`, `Monthly API spend crossed $${dollars}.${resetText}`);
}

function notifyApiDisabled(account: Account, reason: string): void {
  notify(`switchboard-api-disabled:${account.id}:${Date.now()}`, `${accountLabel(account)} is out of API access`, `Claude Platform disabled the API for this org: ${reason}.`);
}

function notifyAutoSwitch(account: Account | undefined, ruleId: string): void {
  notify(`switchboard-auto-switch:${ruleId}:${Date.now()}`, 'Switchboard switched accounts automatically', `Now using ${account ? accountLabel(account) : 'a different account'}.`);
}

interface RefreshResult extends UsageFetchResult {
  id: string;
  service: Service;
  prevUsage: UsageSnapshot | null;
  prevSessionExpired: boolean;
}

/** Fires every notification type tied to one account's usage refresh, per
 * `settings.notifications` — each fires once per crossing/state change, since it's always compared
 * against the account's own previous stored state. */
function notifyForUsageChange(account: Account, result: RefreshResult, settings: Settings): void {
  const { usage, prevUsage, sessionExpired, prevSessionExpired } = result;

  if (result.service === 'platform') {
    const n = settings.notifications.platform;
    if (!n.enabled) return;
    if (n.sessionExpired && !prevSessionExpired && sessionExpired) notifySessionExpired(account);

    const prevSpend = prevUsage?.billing?.spendCents ?? null;
    const nextSpend = usage?.billing?.spendCents ?? null;
    const prevResetsAt = prevUsage?.billing?.spendResetsAt ?? null;
    const nextResetsAt = usage?.billing?.spendResetsAt ?? null;
    // A new billing period (the reset timestamp moved) starts spend over at 0 — without this, a
    // post-reset spend that's numerically lower than the old period's would look like "went down"
    // and never re-cross thresholds that are, in the new period, freshly crossed.
    const newBillingPeriod = prevResetsAt !== null && nextResetsAt !== null && prevResetsAt !== nextResetsAt;
    const effectivePrevSpend = newBillingPeriod ? 0 : prevSpend;
    // notifyOnUnknownPrev: false — a brand-new account (or one whose only prior reads were all
    // transient failures) has no real baseline yet; its first known spend shouldn't look like a
    // "crossing" of every threshold below it.
    for (const cents of valueCrossings(effectivePrevSpend, nextSpend, n.spendThresholdsCents, { notifyOnUnknownPrev: false })) {
      notifySpendThresholdCrossed(account, cents, usage);
    }

    const prevDisabled = prevUsage?.billing?.apiDisabledReason ?? null;
    const nextDisabled = usage?.billing?.apiDisabledReason ?? null;
    if (n.apiDisabled && prevDisabled === null && nextDisabled !== null) notifyApiDisabled(account, nextDisabled);
    return;
  }

  const n = settings.notifications.claude;
  if (!n.enabled) return;
  if (n.sessionExpired && !prevSessionExpired && sessionExpired) notifySessionExpired(account);
  for (const percent of thresholdCrossings(prevUsage, usage, n.usageThresholds)) notifyThresholdCrossed(account, percent, usage);
  if (n.limitReached && !isLimitReached(prevUsage) && isLimitReached(usage)) notifyLimitReached(account);
}

// Serializes the whole read→fetch→notify→write sequence so an alarm-triggered poll and a
// popup-triggered refresh (or two overlapping alarm ticks) can never run concurrently. Without
// this, two calls can both read the same stale `prevUsage` before either writes back, and both
// independently detect — and notify — the same threshold crossing.
let refreshQueue: Promise<unknown> = Promise.resolve();

export function refreshUsage(accountId?: string): Promise<void> {
  const run = refreshQueue.then(() => refreshUsageLocked(accountId));
  refreshQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Refreshes usage for one account (or all accounts when `accountId` is omitted) and fires any
 * notification whose condition that refresh crossed. */
async function refreshUsageLocked(accountId?: string): Promise<void> {
  const state = await loadState();
  const targets = accountId ? state.accounts.filter((a) => a.id === accountId) : state.accounts;
  const secretsByAccountId = new Map(state.secrets.map((s) => [s.accountId, s.sessionKey]));

  // Only trust the plain (browser-cookie) fetch for an active account if the live `sessionKey`
  // cookie for that service actually still matches what we think its secret is. If it doesn't — the
  // user logged in as someone else directly, outside the extension — claude.ai falls back to its
  // DNR-override path using OUR stored secret; platform has no such fallback and just skips (see
  // `fetchUsageForPlatform`). Either way we never silently attribute a different session's data to
  // the wrong account.
  // Each service's cookie lookup is isolated: an unexpected failure reading one service's cookie
  // must never abort the whole refresh (and therefore the other service's accounts) — fail soft
  // to "no live cookie", which downstream treats the same as a logged-out browser.
  const liveCookies: Record<Service, chrome.cookies.Cookie | null> = {
    claude: await getCurrentSessionCookie('claude').catch(() => null),
    platform: await getCurrentSessionCookie('platform').catch(() => null),
  };
  const activeIdFor = (service: Service): string | null => (service === 'platform' ? state.activePlatformAccountId : state.activeAccountId);
  const activeSecretMismatch = (service: Service): boolean => {
    const activeId = activeIdFor(service);
    const liveCookie = liveCookies[service];
    return activeId !== null && liveCookie !== null && secretsByAccountId.get(activeId) !== undefined && liveCookie.value !== secretsByAccountId.get(activeId);
  };

  const results: RefreshResult[] = await Promise.all(
    targets.map(async (account) => {
      const service = serviceOf(account);
      const isActiveAccount = account.id === activeIdFor(service);
      const base = { id: account.id, service, prevUsage: account.usage, prevSessionExpired: Boolean(account.sessionExpired) };

      if (isActiveAccount && liveCookies[service] === null) {
        // No live session cookie at all for this service right now (mid addAccountFlow, a direct
        // logout, a tab closed between polls, ...). That says nothing about whether the SAVED
        // session is still valid, so skip this account's fetch entirely rather than guessing via a
        // request that's certain to 401 or silently reusing a stale assumption — don't flip
        // sessionExpired, don't notify, just keep the last known value.
        return { ...base, usage: account.usage, sessionExpired: Boolean(account.sessionExpired), usageError: account.usageError };
      }

      const useActivePath = isActiveAccount && !activeSecretMismatch(service);
      const fetched = await fetchUsageFor(account, useActivePath, secretsByAccountId.get(account.id));
      return { ...base, ...fetched };
    }),
  );

  const stateAfterFetch = await loadState();
  if (stateAfterFetch.activeAccountId !== state.activeAccountId || stateAfterFetch.activePlatformAccountId !== state.activePlatformAccountId) {
    // An active account (either service) changed while these fetches were in flight (e.g. a
    // concurrent switch) — our assumptions are now stale, so discard this batch entirely rather than
    // risk writing usage under the wrong account. The next poll tick will get it right.
    return;
  }

  await updateState((s: StorageSchema) => ({
    ...s,
    accounts: s.accounts.map((a) => {
      const r = results.find((x) => x.id === a.id);
      return r ? { ...a, usage: r.usage, sessionExpired: r.sessionExpired, usageError: r.usageError } : a;
    }),
  }));

  for (const r of results) {
    const account = targets.find((a) => a.id === r.id)!;
    notifyForUsageChange(account, r, state.settings);
  }
}

const BADGE_COLORS = { green: '#16a34a', amber: '#d97706', red: '#dc2626' } as const;

/** The toolbar badge is claude.ai-only (platform support is account management, not a metric to
 * surface in the badge) — `serviceOf(a) === 'claude'` guards that even if `activeAccountId` were
 * ever to reference something else. */
export async function updateBadge(): Promise<void> {
  const state = await loadState();
  const active = state.accounts.find((a) => a.id === state.activeAccountId && serviceOf(a) === 'claude') ?? null;
  const value = state.settings.showBadge ? getMetricValue(active?.usage ?? null, state.settings.badgeMetric) : null;

  if (value === null) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const rounded = Math.round(value);
  await chrome.action.setBadgeText({ text: `${rounded}%` });
  await chrome.action.setBadgeBackgroundColor({ color: rounded >= 90 ? BADGE_COLORS.red : rounded >= 70 ? BADGE_COLORS.amber : BADGE_COLORS.green });
}

async function getPendingConfirmations(): Promise<Record<string, PendingConfirmation>> {
  const result = await chrome.storage.session.get(PENDING_CONFIRMATIONS_KEY);
  return ((result as Record<string, unknown>)[PENDING_CONFIRMATIONS_KEY] as Record<string, PendingConfirmation> | undefined) ?? {};
}

async function addPendingConfirmation(notificationId: string, confirmation: PendingConfirmation): Promise<void> {
  const current = await getPendingConfirmations();
  await chrome.storage.session.set({ [PENDING_CONFIRMATIONS_KEY]: { ...current, [notificationId]: confirmation } });
}

async function takePendingConfirmation(notificationId: string): Promise<PendingConfirmation | null> {
  const current = await getPendingConfirmations();
  const confirmation = current[notificationId];
  if (!confirmation) return null;
  const { [notificationId]: _removed, ...rest } = current;
  await chrome.storage.session.set({ [PENDING_CONFIRMATIONS_KEY]: rest });
  return confirmation;
}

function requestSwitchConfirmation(account: Account | undefined, ruleId: string, switchTo: string): void {
  const notificationId = `switchboard-confirm:${ruleId}:${Date.now()}`;
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: 'Switchboard wants to switch accounts',
    message: `Rule triggered: switch away from ${account ? accountLabel(account) : 'the active account'}?`,
    buttons: [{ title: 'Switch now' }, { title: 'Dismiss' }],
  });
  void addPendingConfirmation(notificationId, { ruleId, switchTo });
}

/** One usage-poll tick: refresh usage, then run the (claude.ai-only) rules engine against the fresh
 * data. */
export async function runPollCycle(): Promise<void> {
  await refreshUsage();
  const state = await loadState();
  const result = evaluateRules(
    { accounts: state.accounts, activeAccountId: state.activeAccountId, rules: state.rules, settings: state.settings, lastRuleFire: state.lastRuleFire },
    Date.now(),
  );
  if (!result) return;

  await updateState((s) => ({ ...s, lastRuleFire: { ...s.lastRuleFire, [result.ruleId]: Date.now(), [GLOBAL_SWITCH_GAP_KEY]: Date.now() } }));

  if (result.confirm) {
    requestSwitchConfirmation(state.accounts.find((a) => a.id === state.activeAccountId), result.ruleId, result.switchTo);
    return;
  }
  await switchAccount(result.switchTo, 'rule', result.ruleId);
  await updateBadge();
  const n = state.settings.notifications.claude;
  if (n.enabled && n.autoSwitch) notifyAutoSwitch(state.accounts.find((a) => a.id === result.switchTo), result.ruleId);
}

/** The manual "switch to next account" shortcut/message for `service` (default claude.ai),
 * independent of any rule. Rotates only among that service's accounts. */
export async function switchToNext(service: Service = 'claude'): Promise<void> {
  const state = await loadState();
  const activeId = service === 'platform' ? state.activePlatformAccountId : state.activeAccountId;
  const scopedAccounts = state.accounts.filter((a) => serviceOf(a) === service);
  const nextId = nextEligibleAccount(scopedAccounts, activeId, state.settings.accountOrder);
  if (!nextId) return;
  await switchAccount(nextId, 'shortcut');
  await updateBadge();
}

/** Handles a click on either button of a switch-confirmation notification: re-validates the target
 * (it may have been removed/paused/expired since the notification was created) and never lets a
 * failed switch escape as an unhandled rejection in the service worker. */
async function handleConfirmationButtonClicked(notificationId: string, buttonIndex: number): Promise<void> {
  const confirmation = await takePendingConfirmation(notificationId);
  if (!confirmation) return;
  chrome.notifications.clear(notificationId);
  if (buttonIndex !== 0) return; // "Dismiss"

  try {
    const state = await loadState();
    const target = state.accounts.find((a) => a.id === confirmation.switchTo);
    if (!target || target.paused || target.sessionExpired) return;
    await switchAccount(confirmation.switchTo, 'rule', confirmation.ruleId);
    await updateBadge();
  } catch {
    // The confirmation is already consumed either way; a future poll cycle re-evaluates normally.
  }
}

/** The notification can also disappear without a button click (auto-dismissed, or the user closed
 * it directly) — clean up its pending entry so a stray later event can't replay it. */
async function handleConfirmationNotificationClosed(notificationId: string): Promise<void> {
  await takePendingConfirmation(notificationId);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) void runPollCycle();
});

chrome.notifications.onButtonClicked.addListener(handleConfirmationButtonClicked);
chrome.notifications.onClosed.addListener(handleConfirmationNotificationClosed);

chrome.commands.onCommand.addListener((command) => {
  if (command === 'switch-next') void switchToNext();
});
