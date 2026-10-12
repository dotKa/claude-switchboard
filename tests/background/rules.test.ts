import { describe, expect, it } from 'vitest';
import { evaluateRules, getMetricValue, isLimitReached, nextEligibleAccount, thresholdCrossings, valueCrossings } from '../../src/background/rules';
import type { Account, RuleEngineInput, Settings, SwitchRule, UsageSnapshot } from '../../src/background/rules';
import { DEFAULT_SETTINGS } from '../../src/shared/types';

function usage(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    fetchedAt: 0,
    limits: [],
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    extraUsage: null,
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    email: 'a1@example.com',
    displayName: 'A1',
    orgId: 'org1',
    orgName: 'Org',
    plan: 'pro',
    addedAt: 0,
    lastUsedAt: null,
    usage: null,
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, autoSwitchEnabled: true, ...overrides };
}

function rule(overrides: Partial<SwitchRule> = {}): SwitchRule {
  return {
    id: 'r1',
    name: 'Rule 1',
    enabled: true,
    condition: { type: 'usageAbove', metric: 'maxAny', percent: 80 },
    target: { type: 'next' },
    cooldownMinutes: 10,
    confirm: false,
    ...overrides,
  };
}

function state(overrides: Partial<RuleEngineInput> = {}): RuleEngineInput {
  return {
    accounts: [],
    activeAccountId: null,
    rules: [],
    settings: settings(),
    lastRuleFire: {},
    ...overrides,
  };
}

describe('getMetricValue', () => {
  it('returns null for null usage', () => {
    expect(getMetricValue(null, 'maxAny')).toBeNull();
    expect(getMetricValue(null, 'fiveHour')).toBeNull();
  });

  it('returns the specific window utilization', () => {
    expect(getMetricValue(usage({ fiveHour: { utilization: 42, resetsAt: null } }), 'fiveHour')).toBe(42);
  });

  it('returns null for a specific window metric when that window is absent', () => {
    expect(getMetricValue(usage({ fiveHour: null }), 'fiveHour')).toBeNull();
  });

  it('maxAny picks the highest percent across limits and windows', () => {
    const u = usage({
      limits: [
        { kind: 'session', group: 'session', percent: 30, severity: 'normal', resetsAt: null, scopeLabel: null, isActive: true },
        { kind: 'weekly', group: 'weekly', percent: 65, severity: 'normal', resetsAt: null, scopeLabel: null, isActive: true },
      ],
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: { utilization: 99, resetsAt: null },
    });
    expect(getMetricValue(u, 'maxAny')).toBe(99);
  });

  it('maxAny returns null when there is no data at all', () => {
    expect(getMetricValue(usage(), 'maxAny')).toBeNull();
  });
});

describe('isLimitReached', () => {
  it('is false for null usage', () => {
    expect(isLimitReached(null)).toBe(false);
  });

  it('is true when an active limit is at 100%', () => {
    const u = usage({
      limits: [{ kind: 'session', group: 'session', percent: 100, severity: 'critical', resetsAt: null, scopeLabel: null, isActive: true }],
    });
    expect(isLimitReached(u)).toBe(true);
  });

  it('is false when the 100% limit is not active', () => {
    const u = usage({
      limits: [{ kind: 'session', group: 'session', percent: 100, severity: 'critical', resetsAt: null, scopeLabel: null, isActive: false }],
    });
    expect(isLimitReached(u)).toBe(false);
  });

  it('is true when a legacy window hits 100%', () => {
    expect(isLimitReached(usage({ fiveHour: { utilization: 100, resetsAt: null } }))).toBe(true);
  });

  it('is false when nothing is at 100%', () => {
    expect(isLimitReached(usage({ fiveHour: { utilization: 50, resetsAt: null } }))).toBe(false);
  });
});

describe('evaluateRules — gating', () => {
  it('returns null when autoSwitchEnabled is false', () => {
    const s = state({
      settings: settings({ autoSwitchEnabled: false }),
      accounts: [account({ id: 'a1' }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [rule()],
    });
    expect(evaluateRules(s, Date.now())).toBeNull();
  });

  it('returns null when there are no rules', () => {
    expect(evaluateRules(state({ activeAccountId: 'a1', accounts: [account()] }), Date.now())).toBeNull();
  });

  it('returns null when the matching rule is disabled', () => {
    const s = state({
      accounts: [account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [rule({ enabled: false, condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 } })],
    });
    expect(evaluateRules(s, Date.now())).toBeNull();
  });

  it('respects cooldown and blocks refiring within the window', () => {
    const now = 1_000_000;
    const s = state({
      accounts: [account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [rule({ condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, cooldownMinutes: 10 })],
      lastRuleFire: { r1: now - 5 * 60_000 },
    });
    expect(evaluateRules(s, now)).toBeNull();
  });

  it('fires again once the cooldown has elapsed', () => {
    const now = 1_000_000;
    const s = state({
      accounts: [
        account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }),
        account({ id: 'a2', usage: usage({ fiveHour: { utilization: 10, resetsAt: null } }) }),
      ],
      activeAccountId: 'a1',
      rules: [rule({ condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, cooldownMinutes: 10 })],
      lastRuleFire: { r1: now - 11 * 60_000 },
    });
    expect(evaluateRules(s, now)).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });
});

describe('evaluateRules — conditions', () => {
  it('usageAbove fires only when strictly above the threshold', () => {
    const r = rule({ condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 } });
    const below = state({
      accounts: [account({ id: 'a1', usage: usage({ fiveHour: { utilization: 80, resetsAt: null } }) }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [r],
    });
    expect(evaluateRules(below, Date.now())).toBeNull();

    const above = state({
      accounts: [
        account({ id: 'a1', usage: usage({ fiveHour: { utilization: 81, resetsAt: null } }) }),
        account({ id: 'a2', usage: usage({ fiveHour: { utilization: 10, resetsAt: null } }) }),
      ],
      activeAccountId: 'a1',
      rules: [r],
    });
    expect(evaluateRules(above, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('limitReached fires when the active account has a maxed-out limit', () => {
    const r = rule({ condition: { type: 'limitReached' } });
    const s = state({
      accounts: [
        account({ id: 'a1', usage: usage({ limits: [{ kind: 'session', group: 'session', percent: 100, severity: 'critical', resetsAt: null, scopeLabel: null, isActive: true }] }) }),
        account({ id: 'a2' }),
      ],
      activeAccountId: 'a1',
      rules: [r],
    });
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('limitReached does not fire when under 100%', () => {
    const r = rule({ condition: { type: 'limitReached' } });
    const s = state({
      accounts: [account({ id: 'a1', usage: usage({ fiveHour: { utilization: 99, resetsAt: null } }) }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [r],
    });
    expect(evaluateRules(s, Date.now())).toBeNull();
  });

  it('schedule does not fire before today\'s HH:MM', () => {
    const r = rule({ condition: { type: 'schedule', cron: '09:30' } });
    const s = state({ accounts: [account({ id: 'a1' }), account({ id: 'a2' })], activeAccountId: 'a1', rules: [r] });
    const before = new Date();
    before.setHours(9, 29, 59, 0);
    expect(evaluateRules(s, before.getTime())).toBeNull();
  });

  it('schedule fires on the first poll at or after today\'s HH:MM', () => {
    const r = rule({ condition: { type: 'schedule', cron: '09:30' } });
    const s = state({ accounts: [account({ id: 'a1' }), account({ id: 'a2' })], activeAccountId: 'a1', rules: [r] });
    const at = new Date();
    at.setHours(9, 31, 0, 0);
    expect(evaluateRules(s, at.getTime())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('schedule does not refire later the same day once it has already fired today', () => {
    const r = rule({ condition: { type: 'schedule', cron: '09:30' } });
    const firstFire = new Date();
    firstFire.setHours(9, 30, 0, 0);
    const laterSameDay = new Date();
    laterSameDay.setHours(14, 0, 0, 0);
    const s = state({
      accounts: [account({ id: 'a1' }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [r],
      lastRuleFire: { r1: firstFire.getTime() },
    });
    expect(evaluateRules(s, laterSameDay.getTime())).toBeNull();
  });

  it('schedule fires again the following day', () => {
    const r = rule({ condition: { type: 'schedule', cron: '09:30' } });
    const yesterdayFire = new Date();
    yesterdayFire.setDate(yesterdayFire.getDate() - 1);
    yesterdayFire.setHours(9, 30, 0, 0);
    const todayAfterSchedule = new Date();
    todayAfterSchedule.setHours(10, 0, 0, 0);
    const s = state({
      accounts: [account({ id: 'a1' }), account({ id: 'a2' })],
      activeAccountId: 'a1',
      rules: [r],
      lastRuleFire: { r1: yesterdayFire.getTime() },
    });
    expect(evaluateRules(s, todayAfterSchedule.getTime())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('rejects a malformed schedule cron string instead of matching it', () => {
    const r = rule({ condition: { type: 'schedule', cron: '9:30' } }); // missing leading zero
    const s = state({ accounts: [account({ id: 'a1' }), account({ id: 'a2' })], activeAccountId: 'a1', rules: [r] });
    const at = new Date();
    at.setHours(9, 30, 0, 0);
    expect(evaluateRules(s, at.getTime())).toBeNull();
  });

  it('rejects an out-of-range schedule cron string', () => {
    const r = rule({ condition: { type: 'schedule', cron: '99:99' } });
    const s = state({ accounts: [account({ id: 'a1' }), account({ id: 'a2' })], activeAccountId: 'a1', rules: [r] });
    expect(evaluateRules(s, Date.now())).toBeNull();
  });
});

describe('evaluateRules — targets', () => {
  const triggered = () =>
    state({
      accounts: [
        account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }),
        account({ id: 'a2', usage: usage({ fiveHour: { utilization: 10, resetsAt: null } }) }),
        account({ id: 'a3', usage: usage({ fiveHour: { utilization: 50, resetsAt: null } }) }),
      ],
      activeAccountId: 'a1',
      rules: [rule({ condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 } })],
    });

  it('next: round-robins in settings.accountOrder, skipping paused and expired', () => {
    const s = triggered();
    s.settings.accountOrder = ['a1', 'a2', 'a3'];
    s.accounts[1]!.paused = true;
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('next: wraps around to the start of accountOrder when the active account is last', () => {
    const s = triggered();
    s.settings.accountOrder = ['a2', 'a3', 'a1']; // active (a1) is last -> wraps to a2
    s.accounts[1]!.paused = true; // a2 paused -> skip past it to a3
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('next: accounts missing from accountOrder are appended at the end, not excluded', () => {
    const s = triggered();
    s.settings.accountOrder = ['a3', 'a1']; // a2 is not listed
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('next: falls back to account array order when accountOrder is empty', () => {
    const s = triggered();
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('lowestUsage: picks the eligible account with the smallest metric value', () => {
    const s = triggered();
    s.rules[0]!.target = { type: 'lowestUsage', metric: 'fiveHour' };
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
  });

  it('lowestUsage: skips accounts with no usage data yet', () => {
    const s = triggered();
    s.accounts[1]!.usage = null; // a2 would otherwise win
    s.rules[0]!.target = { type: 'lowestUsage', metric: 'fiveHour' };
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('specific: fires when the named account is eligible', () => {
    const s = triggered();
    s.rules[0]!.target = { type: 'specific', accountId: 'a3' };
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('specific: returns null when the named account is paused', () => {
    const s = triggered();
    s.accounts[2]!.paused = true;
    s.rules[0]!.target = { type: 'specific', accountId: 'a3' };
    expect(evaluateRules(s, Date.now())).toBeNull();
  });

  it('priority: picks the first eligible account in accountOrder', () => {
    const s = triggered();
    s.settings.accountOrder = ['a3', 'a2', 'a1'];
    s.rules[0]!.target = { type: 'priority' };
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('excludes sessionExpired accounts as switch targets', () => {
    const s = triggered();
    s.accounts[1]!.sessionExpired = true;
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('targetMaxPercent filters out accounts whose metric is too high', () => {
    const s = triggered();
    s.rules[0]!.targetMaxPercent = 40;
    // a2=10 passes, a3=50 fails
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: false });
    s.rules[0]!.targetMaxPercent = 5;
    expect(evaluateRules(s, Date.now())).toBeNull();
  });

  it('falls through to the next rule when the first has no eligible target', () => {
    const s = triggered();
    s.accounts[1]!.paused = true;
    s.accounts[2]!.paused = true;
    s.rules = [
      rule({ id: 'r1', condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'next' } }),
      rule({ id: 'r2', condition: { type: 'limitReached' }, target: { type: 'specific', accountId: 'a1' } }),
    ];
    // r1 matches condition but has no eligible target (both others paused) -> falls through
    // r2's condition (limitReached) is false for a1, so overall null
    expect(evaluateRules(s, Date.now())).toBeNull();
  });

  it('carries the rule confirm flag through to the result', () => {
    const s = triggered();
    s.rules[0]!.confirm = true;
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a2', confirm: true });
  });

  it('defaults targetMaxPercent to the usageAbove condition percent, preventing ping-pong onto an equally overloaded account', () => {
    const s = triggered();
    s.accounts[1]!.usage = usage({ fiveHour: { utilization: 85, resetsAt: null } }); // a2 is also above the 80% threshold
    // a3 stays at 50%, below threshold -> should be picked over a2 even though no explicit targetMaxPercent is set
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('excludes targets with unknown usage once there is an effective targetMaxPercent', () => {
    const s = triggered();
    s.accounts[1]!.usage = null; // a2's usage is unknown
    // only a3 (known, under threshold) should be eligible; a2 must not be picked just because it's "unknown"
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });

  it('excludes targets that are themselves at a hard limit', () => {
    const s = triggered();
    s.accounts[1]!.usage = usage({ limits: [{ kind: 'session', group: 'session', percent: 100, severity: 'critical', resetsAt: null, scopeLabel: null, isActive: true }] });
    expect(evaluateRules(s, Date.now())).toEqual({ ruleId: 'r1', switchTo: 'a3', confirm: false });
  });
});

describe('evaluateRules — global minimum gap between auto switches', () => {
  it('blocks any rule from firing within the global gap, even a different rule with no cooldown conflict', () => {
    const now = 1_000_000;
    const s = state({
      accounts: [
        account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }),
        account({ id: 'a2', usage: usage({ fiveHour: { utilization: 10, resetsAt: null } }) }),
      ],
      activeAccountId: 'a1',
      rules: [rule({ id: 'r2', condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, cooldownMinutes: 0 })],
      lastRuleFire: { __global__: now - 5 * 60_000 },
    });
    expect(evaluateRules(s, now)).toBeNull();
  });

  it('allows firing once the global gap has elapsed', () => {
    const now = 1_000_000;
    const s = state({
      accounts: [
        account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }),
        account({ id: 'a2', usage: usage({ fiveHour: { utilization: 10, resetsAt: null } }) }),
      ],
      activeAccountId: 'a1',
      rules: [rule({ id: 'r2', condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, cooldownMinutes: 0 })],
      lastRuleFire: { __global__: now - 11 * 60_000 },
    });
    expect(evaluateRules(s, now)).toEqual({ ruleId: 'r2', switchTo: 'a2', confirm: false });
  });
});

describe('thresholdCrossings', () => {
  it('returns thresholds crossed upward between two snapshots', () => {
    const prev = usage({ fiveHour: { utilization: 70, resetsAt: null } });
    const next = usage({ fiveHour: { utilization: 96, resetsAt: null } });
    expect(thresholdCrossings(prev, next, [80, 95])).toEqual([80, 95]);
  });

  it('does not report thresholds that were already crossed before', () => {
    const prev = usage({ fiveHour: { utilization: 85, resetsAt: null } });
    const next = usage({ fiveHour: { utilization: 96, resetsAt: null } });
    expect(thresholdCrossings(prev, next, [80, 95])).toEqual([95]);
  });

  it('returns nothing when usage goes down', () => {
    const prev = usage({ fiveHour: { utilization: 96, resetsAt: null } });
    const next = usage({ fiveHour: { utilization: 50, resetsAt: null } });
    expect(thresholdCrossings(prev, next, [80, 95])).toEqual([]);
  });

  it('treats a missing previous snapshot as already-crossable (notifies on first poll)', () => {
    const next = usage({ fiveHour: { utilization: 90, resetsAt: null } });
    expect(thresholdCrossings(null, next, [80, 95])).toEqual([80]);
  });

  it('returns nothing when the next snapshot has no usable metric', () => {
    expect(thresholdCrossings(null, null, [80, 95])).toEqual([]);
    expect(thresholdCrossings(usage(), usage(), [80, 95])).toEqual([]);
  });
});

describe('nextEligibleAccount', () => {
  const accounts = [account({ id: 'a1' }), account({ id: 'a2' }), account({ id: 'a3' })];

  it('picks the next account after the active one in accountOrder', () => {
    expect(nextEligibleAccount(accounts, 'a1', ['a1', 'a2', 'a3'])).toBe('a2');
  });

  it('wraps around past the end of the order', () => {
    expect(nextEligibleAccount(accounts, 'a3', ['a1', 'a2', 'a3'])).toBe('a1');
  });

  it('skips paused and sessionExpired accounts', () => {
    const withPaused = [account({ id: 'a1' }), account({ id: 'a2', paused: true }), account({ id: 'a3', sessionExpired: true }), account({ id: 'a4' })];
    expect(nextEligibleAccount(withPaused, 'a1', ['a1', 'a2', 'a3', 'a4'])).toBe('a4');
  });

  it('falls back to array order when accountOrder is empty', () => {
    expect(nextEligibleAccount(accounts, 'a1', [])).toBe('a2');
  });

  it('returns null when there is no other eligible account', () => {
    expect(nextEligibleAccount([account({ id: 'a1' })], 'a1', [])).toBeNull();
  });

  it('starts from the beginning when there is no active account', () => {
    expect(nextEligibleAccount(accounts, null, ['a1', 'a2', 'a3'])).toBe('a1');
  });
});

describe('evaluateRules — platform accounts are excluded', () => {
  it('never resolves a platform account as a switch target', () => {
    const s = state({
      accounts: [
        account({ id: 'a1', usage: usage({ fiveHour: { utilization: 90, resetsAt: null } }) }),
        account({ id: 'platform:p1', service: 'platform' as never, usage: usage({ fiveHour: { utilization: 1, resetsAt: null } }) }),
      ],
      activeAccountId: 'a1',
      rules: [rule({ condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'lowestUsage', metric: 'fiveHour' } })],
    });
    expect(evaluateRules(s, Date.now())).toBeNull(); // the only other account is a platform one -> no eligible target
  });

  it('ignores a platform account even if it happens to be passed as activeAccountId', () => {
    const s = state({
      accounts: [account({ id: 'platform:p1', service: 'platform' as never, usage: usage({ fiveHour: { utilization: 99, resetsAt: null } }) }), account({ id: 'a2' })],
      activeAccountId: 'platform:p1',
      rules: [rule({ condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 } })],
    });
    // the "active account" the condition checks against is only ever a claude one; a platform id here resolves to no active account at all
    expect(evaluateRules(s, Date.now())).toBeNull();
  });
});

describe('valueCrossings', () => {
  it('generalizes thresholdCrossings to arbitrary numeric values (e.g. cents)', () => {
    expect(valueCrossings(500, 1500, [1000, 2000])).toEqual([1000]);
  });

  it('treats a null previous value as below every threshold', () => {
    expect(valueCrossings(null, 1500, [1000, 2000])).toEqual([1000]);
  });

  it('returns nothing when the next value is null', () => {
    expect(valueCrossings(500, null, [1000])).toEqual([]);
  });

  it('returns nothing when the value goes down', () => {
    expect(valueCrossings(2500, 500, [1000, 2000])).toEqual([]);
  });

  it('suppresses crossings on a null previous value when notifyOnUnknownPrev is false (first observation = baseline)', () => {
    expect(valueCrossings(null, 1500, [1000, 2000], { notifyOnUnknownPrev: false })).toEqual([]);
  });

  it('still reports crossings normally once a real previous value exists, even with notifyOnUnknownPrev: false', () => {
    expect(valueCrossings(500, 1500, [1000, 2000], { notifyOnUnknownPrev: false })).toEqual([1000]);
  });
});
