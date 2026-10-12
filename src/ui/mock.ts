// Mock state for developing popup/options without the background service worker.
// Only used when `chrome.runtime.id` is unavailable (plain vite dev server / detached tab).
// Not imported by the service worker bundle.
import type { PublicState } from '../shared/messages';
import type { Account, SwitchEvent, UsageLimit, UsageWindow } from '../shared/types';

const now = Date.now();
const H = 60 * 60 * 1000;
const D = 24 * H;

function sessionLimit(percent: number, resetsInMs: number): UsageLimit {
  return {
    kind: 'session',
    group: 'session',
    percent,
    severity: percent >= 90 ? 'critical' : percent >= 60 ? 'warning' : 'normal',
    resetsAt: new Date(now + resetsInMs).toISOString(),
    scopeLabel: null,
    isActive: true,
  };
}

function weeklyLimit(percent: number, resetsInMs: number, scopeLabel: string | null): UsageLimit {
  const scoped = scopeLabel !== null;
  return {
    kind: scoped ? 'weekly_scoped' : 'weekly',
    group: 'weekly',
    percent,
    severity: percent >= 90 ? 'critical' : percent >= 60 ? 'warning' : 'normal',
    resetsAt: new Date(now + resetsInMs).toISOString(),
    scopeLabel,
    isActive: percent > 0 || !scoped,
  };
}

function sessionWindow(percent: number, resetsInMs: number): UsageWindow {
  return { utilization: percent, resetsAt: new Date(now + resetsInMs).toISOString() };
}

function makeAccount(partial: Partial<Account> & Pick<Account, 'id' | 'email' | 'displayName'>): Account {
  return {
    orgId: `org-${partial.id}`,
    orgName: `${partial.displayName}'s org`,
    plan: 'pro',
    addedAt: now - 30 * D,
    lastUsedAt: now - 2 * D,
    usage: null,
    ...partial,
  };
}

export function createMockState(): PublicState {
  const accounts: Account[] = [
    makeAccount({
      id: 'acct-anna',
      email: 'anna@example.com',
      displayName: 'Anna',
      label: 'Anna (work)',
      color: '#3d8546',
      plan: 'pro',
      lastUsedAt: now - 10 * 60 * 1000,
      usage: {
        fetchedAt: now - 2 * 60 * 1000,
        limits: [
          sessionLimit(38, 2 * H + 14 * 60 * 1000),
          weeklyLimit(61, 3 * D + 5 * H, null),
          weeklyLimit(24, 3 * D + 5 * H, 'Sonnet'),
        ],
        fiveHour: sessionWindow(38, 2 * H + 14 * 60 * 1000),
        sevenDay: sessionWindow(61, 3 * D + 5 * H),
        sevenDayOpus: null,
        sevenDaySonnet: sessionWindow(24, 3 * D + 5 * H),
        extraUsage: null,
      },
    }),
    makeAccount({
      id: 'acct-ben',
      email: 'ben@example.com',
      displayName: 'Ben',
      label: 'Ben',
      color: '#d97757',
      plan: 'max',
      usage: {
        fetchedAt: now - 12 * 60 * 1000, // stale at the default 5-min poll interval
        limits: [
          sessionLimit(82, 45 * 60 * 1000),
          weeklyLimit(44, 5 * D, null),
          weeklyLimit(71, 5 * D, 'Opus'),
        ],
        fiveHour: sessionWindow(82, 45 * 60 * 1000),
        sevenDay: sessionWindow(44, 5 * D),
        sevenDayOpus: sessionWindow(71, 5 * D),
        sevenDaySonnet: null,
        extraUsage: { enabled: true, utilization: 12, spendLimitReached: false },
      },
    }),
    makeAccount({
      id: 'acct-cara',
      email: 'cara@example.com',
      displayName: 'Cara',
      label: 'Cara (client)',
      color: '#5b7bd5',
      plan: 'free',
      paused: true,
      sessionExpired: true,
      usage: {
        fetchedAt: now - 26 * H,
        limits: [sessionLimit(100, 3 * H), weeklyLimit(96, 6 * D, null)],
        fiveHour: sessionWindow(100, 3 * H),
        sevenDay: sessionWindow(96, 6 * D),
        sevenDayOpus: null,
        sevenDaySonnet: null,
        extraUsage: null,
      },
    }),
    makeAccount({
      id: 'platform:acct-anna',
      service: 'platform',
      email: 'anna@example.com',
      displayName: 'Anna',
      label: 'Anna · API',
      color: '#2f8f8f',
      plan: 'unknown',
      orgName: 'Acme API',
      usage: {
        fetchedAt: now - 3 * 60 * 1000,
        limits: [],
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        extraUsage: null,
        billing: { spendCents: 21_050, spendResetsAt: new Date(now + 19 * D).toISOString(), apiDisabledReason: null },
      },
    }),
    makeAccount({
      id: 'platform:acct-dev',
      service: 'platform',
      email: 'dev@example.com',
      displayName: 'Dev sandbox',
      color: '#8a8f3a',
      plan: 'unknown',
      orgName: 'Sandbox',
      usage: {
        fetchedAt: now - 3 * 60 * 1000,
        limits: [],
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        extraUsage: null,
        billing: null,
      },
    }),
  ];

  const history: SwitchEvent[] = [
    { at: now - 50 * 60 * 1000, fromAccountId: 'platform:acct-dev', toAccountId: 'platform:acct-anna', reason: 'manual', service: 'platform' },
    { at: now - 20 * 60 * 1000, fromAccountId: 'acct-ben', toAccountId: 'acct-anna', reason: 'manual' },
    { at: now - 3 * H, fromAccountId: 'acct-anna', toAccountId: 'acct-ben', reason: 'rule', ruleId: 'rule-1' },
    { at: now - 26 * H, fromAccountId: 'acct-cara', toAccountId: 'acct-anna', reason: 'rule', ruleId: 'rule-2' },
    { at: now - 2 * D, fromAccountId: null, toAccountId: 'acct-cara', reason: 'manual' },
  ];

  return {
    accounts,
    activeAccountId: 'acct-anna',
    activePlatformAccountId: 'platform:acct-anna',
    rules: [
      {
        id: 'rule-1',
        name: 'Rotate when 5-hour gets hot',
        enabled: true,
        condition: { type: 'usageAbove', metric: 'fiveHour', percent: 90 },
        target: { type: 'next' },
        targetMaxPercent: 80,
        cooldownMinutes: 30,
        confirm: false,
      },
      {
        id: 'rule-2',
        name: 'Weekly ceiling → lowest usage',
        enabled: false,
        condition: { type: 'usageAbove', metric: 'sevenDay', percent: 95 },
        target: { type: 'lowestUsage', metric: 'sevenDay' },
        targetMaxPercent: 90,
        cooldownMinutes: 60,
        confirm: true,
      },
    ],
    settings: {
      pollIntervalMinutes: 5,
      notifications: {
        claude: { enabled: true, usageThresholds: [80, 95], limitReached: true, autoSwitch: true, sessionExpired: true },
        platform: { enabled: true, spendThresholdsCents: [10_000, 25_000], apiDisabled: true, sessionExpired: true },
      },
      autoSwitchEnabled: true,
      reloadClaudeTabsOnSwitch: true,
      showBadge: true,
      badgeMetric: 'fiveHour',
      accountOrder: ['acct-anna', 'acct-ben', 'acct-cara'],
      theme: 'system',
    },
    history,
    unsavedSessionDetected: true,
    unsavedPlatformSessionDetected: false,
    platformPermission: true,
  };
}
