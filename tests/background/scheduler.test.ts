import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import type { Account, AccountSecret } from '../../src/shared/types';

vi.mock('../../src/background/claudeApi', async () => {
  const actual = await vi.importActual<typeof import('../../src/background/claudeApi')>('../../src/background/claudeApi');
  return {
    ...actual,
    fetchUsage: vi.fn(),
    fetchUsageWithSessionOverride: vi.fn(),
    fetchPlatformUsage: vi.fn(),
  };
});

vi.mock('../../src/background/session', () => ({
  switchAccount: vi.fn().mockResolvedValue(undefined),
  getCurrentSessionCookie: vi.fn().mockResolvedValue(null),
}));

// Defaults to granted so existing platform tests (written before the optional-permission flow
// existed) keep exercising the normal "platform works" path — the one test for the ungranted case
// overrides this explicitly.
vi.mock('../../src/background/permissions', () => ({
  hasPlatformPermission: vi.fn().mockResolvedValue(true),
}));

let mocks: ReturnType<typeof installChromeMock>;
let scheduler: typeof import('../../src/background/scheduler');
let claudeApi: typeof import('../../src/background/claudeApi');
let session: typeof import('../../src/background/session');
let storage: typeof import('../../src/background/storage');
let permissions: typeof import('../../src/background/permissions');

function usage(utilization: number) {
  return { fetchedAt: Date.now(), limits: [], fiveHour: { utilization, resetsAt: '2026-01-01T00:00:00Z' }, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks = installChromeMock();
  scheduler = await import('../../src/background/scheduler');
  claudeApi = await import('../../src/background/claudeApi');
  session = await import('../../src/background/session');
  storage = await import('../../src/background/storage');
  permissions = await import('../../src/background/permissions');
  vi.mocked(permissions.hasPlatformPermission).mockResolvedValue(true);
  // vi.clearAllMocks() clears call history but NOT a custom mockImplementation/mockResolvedValue
  // from a previous test — reset this one to its sane default explicitly so tests stay independent.
  // Default behavior simulates the common case: the live cookie matches whatever secret the active
  // account (for that service) currently has, so the "active path" fetch proceeds as normal unless a
  // test explicitly overrides this to exercise a mismatch or an absent cookie (see item 4/8 tests).
  vi.mocked(session.getCurrentSessionCookie).mockImplementation(async (service = 'claude') => {
    const state = await storage.loadState();
    const activeId = service === 'platform' ? state.activePlatformAccountId : state.activeAccountId;
    const secret = activeId ? state.secrets.find((s) => s.accountId === activeId) : undefined;
    return secret ? ({ value: secret.sessionKey } as chrome.cookies.Cookie) : null;
  });
});

async function seedState(
  overrides: Partial<{ accounts: Account[]; secrets: AccountSecret[]; activeAccountId: string | null; activePlatformAccountId: string | null }> = {},
) {
  await storage.updateState((s) => ({
    ...s,
    accounts: overrides.accounts ?? [],
    secrets: overrides.secrets ?? [],
    activeAccountId: overrides.activeAccountId ?? null,
    activePlatformAccountId: overrides.activePlatformAccountId ?? null,
  }));
}

function platformUsage(spendCents: number | null, apiDisabledReason: string | null = null, spendResetsAt: string | null = null) {
  return { fetchedAt: Date.now(), limits: [], fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, extraUsage: null, billing: { spendCents, spendResetsAt, apiDisabledReason } };
}

function platformAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'platform:p1',
    service: 'platform',
    email: 'p1@x.com',
    displayName: 'P1',
    orgId: 'porg1',
    orgName: 'O',
    plan: 'unknown',
    addedAt: 0,
    lastUsedAt: 0,
    usage: null,
    ...overrides,
  };
}

describe('refreshUsage', () => {
  it('fetches the active account via fetchUsage and others via fetchUsageWithSessionOverride', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(10));
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(20));

    await scheduler.refreshUsage();

    expect(claudeApi.fetchUsage).toHaveBeenCalledWith('org1');
    expect(claudeApi.fetchUsageWithSessionOverride).toHaveBeenCalledWith('org2', 'k2');
    const state = await storage.loadState();
    expect(state.accounts.find((a) => a.id === 'a1')?.usage?.fiveHour?.utilization).toBe(10);
    expect(state.accounts.find((a) => a.id === 'a2')?.usage?.fiveHour?.utilization).toBe(20);
  });

  it('only refreshes the requested account when accountId is given', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(10));

    await scheduler.refreshUsage('a1');

    expect(claudeApi.fetchUsage).toHaveBeenCalledTimes(1);
    expect(claudeApi.fetchUsageWithSessionOverride).not.toHaveBeenCalled();
  });

  it('marks the account sessionExpired on a 401/403 and keeps its last usage', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockRejectedValue(new claudeApi.SessionExpiredError());

    await scheduler.refreshUsage('a1');

    const state = await storage.loadState();
    const a1 = state.accounts.find((a) => a.id === 'a1')!;
    expect(a1.sessionExpired).toBe(true);
    expect(a1.usage?.fiveHour?.utilization).toBe(5);
  });

  it('falls back to the last known snapshot on a non-auth error (e.g. DNR unsupported)', async () => {
    await seedState({
      accounts: [{ id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(7) }],
      secrets: [{ accountId: 'a2', sessionKey: 'k2' }],
      activeAccountId: null,
    });
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockRejectedValue(new Error('declarativeNetRequest unavailable'));

    await scheduler.refreshUsage('a2');

    const state = await storage.loadState();
    expect(state.accounts[0]!.usage?.fiveHour?.utilization).toBe(7);
    expect(state.accounts[0]!.sessionExpired).toBeFalsy();
  });

  it('creates a notification when a configured threshold is crossed', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(50) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({ ...s, settings: { ...s.settings, notifications: { ...s.settings.notifications, claude: { ...s.settings.notifications.claude, usageThresholds: [80] } } } }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(90));

    await scheduler.refreshUsage('a1');

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('does not notify a crossed threshold when claude notifications are disabled', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(50) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, claude: { ...s.settings.notifications.claude, enabled: false, usageThresholds: [80] } } },
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(90));

    await scheduler.refreshUsage('a1');

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('notifies once when a claude account newly hits a hard usage limit (limitReached)', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(50) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue({
      fetchedAt: Date.now(),
      limits: [{ kind: 'session', group: 'session', percent: 100, severity: 'critical', resetsAt: null, scopeLabel: null, isActive: true }],
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      extraUsage: null,
    });

    await scheduler.refreshUsage('a1');

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('notifies once when a claude account transitions to sessionExpired', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockRejectedValue(new claudeApi.SessionExpiredError());

    await scheduler.refreshUsage('a1');

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('does not re-notify sessionExpired on a later refresh once it was already expired', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5), sessionExpired: true }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockRejectedValue(new claudeApi.SessionExpiredError());

    await scheduler.refreshUsage('a1');

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('does not notify when no threshold was crossed', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(10) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(20));

    await scheduler.refreshUsage('a1');

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('falls back to the override path for the active account when the live cookie does not match its stored secret', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(session.getCurrentSessionCookie).mockResolvedValue({ value: 'someone-elses-live-cookie' } as chrome.cookies.Cookie);
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(42));

    await scheduler.refreshUsage('a1');

    expect(claudeApi.fetchUsage).not.toHaveBeenCalled();
    expect(claudeApi.fetchUsageWithSessionOverride).toHaveBeenCalledWith('org1', 'k1');
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage?.fiveHour?.utilization).toBe(42);
  });

  it('skips the active claude.ai account entirely when there is no live session cookie at all (e.g. mid addAccountFlow)', async () => {
    const existingUsage = usage(42);
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: existingUsage }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(session.getCurrentSessionCookie).mockResolvedValue(null); // no live cookie for either service right now
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(11));

    await scheduler.refreshUsage('a1');

    expect(claudeApi.fetchUsage).not.toHaveBeenCalled();
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage).toEqual(existingUsage);
    expect(state.accounts[0]!.sessionExpired).toBeFalsy();
    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('skips the active platform account entirely when there is no live session cookie at all', async () => {
    const existingUsage = platformUsage(500);
    await seedState({
      accounts: [platformAccount({ usage: existingUsage })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(session.getCurrentSessionCookie).mockResolvedValue(null);

    await scheduler.refreshUsage('platform:p1');

    expect(claudeApi.fetchPlatformUsage).not.toHaveBeenCalled();
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage).toEqual(existingUsage);
    expect(state.accounts[0]!.sessionExpired).toBeFalsy();
  });

  it('discards results if activeAccountId changed during the refresh', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(1) },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(2) },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockImplementation(async () => {
      await storage.updateState((s) => ({ ...s, activeAccountId: 'a2' })); // a switch races in mid-refresh
      return usage(99);
    });
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(88));

    await scheduler.refreshUsage();

    const state = await storage.loadState();
    expect(state.accounts.find((a) => a.id === 'a1')?.usage?.fiveHour?.utilization).toBe(1);
    expect(state.accounts.find((a) => a.id === 'a2')?.usage?.fiveHour?.utilization).toBe(2);
  });

  it('does not mark a non-active account sessionExpired on a 401 from the override path — records usageError instead', async () => {
    await seedState({
      accounts: [{ id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) }],
      secrets: [{ accountId: 'a2', sessionKey: 'k2' }],
      activeAccountId: null,
    });
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockRejectedValue(new claudeApi.SessionExpiredError());

    await scheduler.refreshUsage('a2');

    const state = await storage.loadState();
    const a2 = state.accounts[0]!;
    expect(a2.sessionExpired).toBeFalsy();
    expect(a2.usageError).toBeTruthy();
    expect(a2.usage?.fiveHour?.utilization).toBe(5);
  });

  it('disables the DNR override after a DnrUnavailableError so a later refresh skips it entirely', async () => {
    await seedState({
      accounts: [{ id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(1) }],
      secrets: [{ accountId: 'a2', sessionKey: 'k2' }],
      activeAccountId: null,
    });
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockRejectedValue(new claudeApi.DnrUnavailableError('nope'));

    await scheduler.refreshUsage('a2'); // first attempt: tries, fails, disables the capability

    await storage.updateState((s) => ({
      ...s,
      accounts: [...s.accounts, { id: 'a3', email: '', displayName: '', orgId: 'org3', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(2) }],
      secrets: [...s.secrets, { accountId: 'a3', sessionKey: 'k3' }],
    }));

    await scheduler.refreshUsage('a3'); // a later refresh must not attempt the override again

    expect(claudeApi.fetchUsageWithSessionOverride).toHaveBeenCalledTimes(1);
    const state = await storage.loadState();
    expect(state.accounts.find((a) => a.id === 'a3')?.usageError).toBeTruthy();
    expect(state.accounts.find((a) => a.id === 'a3')?.usage?.fiveHour?.utilization).toBe(2);
  });

  it('clears a previous usageError once a refresh succeeds', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5), usageError: 'stale error' }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(10));

    await scheduler.refreshUsage('a1');

    const state = await storage.loadState();
    expect(state.accounts[0]!.usageError).toBeUndefined();
  });

  it('skips a non-active platform account entirely — no fetch, last value kept', async () => {
    const existingUsage = platformUsage(500);
    await seedState({
      accounts: [platformAccount({ usage: existingUsage })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: null, // not the active platform account
    });

    await scheduler.refreshUsage('platform:p1');

    expect(claudeApi.fetchPlatformUsage).not.toHaveBeenCalled();
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage).toEqual(existingUsage);
  });

  it('refreshes the active platform account via fetchPlatformUsage', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(900));

    await scheduler.refreshUsage('platform:p1');

    expect(claudeApi.fetchPlatformUsage).toHaveBeenCalledWith('porg1', 'https://platform.claude.com');
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage?.billing?.spendCents).toBe(900);
  });

  it('skips the active platform account (no fetch, no error) when the platform permission is missing', async () => {
    const existingUsage = platformUsage(500);
    await seedState({
      accounts: [platformAccount({ usage: existingUsage })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(permissions.hasPlatformPermission).mockResolvedValue(false);

    await scheduler.refreshUsage('platform:p1');

    expect(claudeApi.fetchPlatformUsage).not.toHaveBeenCalled();
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage).toEqual(existingUsage);
    expect(state.accounts[0]!.sessionExpired).toBeFalsy();
    expect(state.accounts[0]!.usageError).toBeFalsy();
  });

  it('refreshing a claude account is unaffected when the platform permission is missing', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(1) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    vi.mocked(permissions.hasPlatformPermission).mockResolvedValue(false);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(42));

    await scheduler.refreshUsage('a1');

    const state = await storage.loadState();
    expect(state.accounts[0]!.usage?.fiveHour?.utilization).toBe(42);
  });

  it('skips the active platform account (keeps last value) when the live cookie does not match its stored secret', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(session.getCurrentSessionCookie).mockImplementation((service?: string) =>
      Promise.resolve(service === 'platform' ? ({ value: 'someone-elses-live-cookie' } as chrome.cookies.Cookie) : null),
    );

    await scheduler.refreshUsage('platform:p1');

    expect(claudeApi.fetchPlatformUsage).not.toHaveBeenCalled();
    const state = await storage.loadState();
    expect(state.accounts[0]!.usage?.billing?.spendCents).toBe(500);
  });

  it('sets sessionExpired on a 401 for the active platform account', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockRejectedValue(new claudeApi.SessionExpiredError());

    await scheduler.refreshUsage('platform:p1');

    const state = await storage.loadState();
    expect(state.accounts[0]!.sessionExpired).toBe(true);
  });

  it('discards results if activePlatformAccountId changed during the refresh', async () => {
    await seedState({
      accounts: [platformAccount({ id: 'platform:p1', usage: platformUsage(1) }), platformAccount({ id: 'platform:p2', usage: platformUsage(2) })],
      secrets: [
        { accountId: 'platform:p1', sessionKey: 'pk1' },
        { accountId: 'platform:p2', sessionKey: 'pk2' },
      ],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockImplementation(async () => {
      await storage.updateState((s) => ({ ...s, activePlatformAccountId: 'platform:p2' }));
      return platformUsage(999);
    });

    await scheduler.refreshUsage();

    const state = await storage.loadState();
    expect(state.accounts.find((a) => a.id === 'platform:p1')?.usage?.billing?.spendCents).toBe(1);
    expect(state.accounts.find((a) => a.id === 'platform:p2')?.usage?.billing?.spendCents).toBe(2);
  });

  it('notifies once when the active platform account crosses a configured spend threshold', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, platform: { ...s.settings.notifications.platform, spendThresholdsCents: [1000] } } },
    }));
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(1500));

    await scheduler.refreshUsage('platform:p1');

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('does not notify a spend threshold crossing when platform notifications are disabled', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, platform: { ...s.settings.notifications.platform, enabled: false, spendThresholdsCents: [1000] } } },
    }));
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(1500));

    await scheduler.refreshUsage('platform:p1');

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('preserves the previous spendCents/spendResetsAt when a refresh returns a null spend (transient current_spend failure)', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(777, null, '2026-02-01T00:00:00Z') })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(null)); // e.g. current_spend failed this time

    await scheduler.refreshUsage('platform:p1');

    const state = await storage.loadState();
    expect(state.accounts[0]!.usage?.billing?.spendCents).toBe(777);
    expect(state.accounts[0]!.usage?.billing?.spendResetsAt).toBe('2026-02-01T00:00:00Z');
  });

  it('does not re-fire thresholds once a transient null-spend refresh is followed by the same known value again', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(1500) })], // already past the 1000 threshold
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, platform: { ...s.settings.notifications.platform, spendThresholdsCents: [1000] } } },
    }));
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(null)); // transient failure — spend preserved at 1500

    await scheduler.refreshUsage('platform:p1'); // this refresh must not re-notify the 1000 threshold

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('does not notify a spend threshold on the very first observation (brand-new account, no baseline yet)', async () => {
    await seedState({
      accounts: [platformAccount({ usage: null })], // never polled before
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, platform: { ...s.settings.notifications.platform, spendThresholdsCents: [1000] } } },
    }));
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(1500)); // already above 1000 on the first ever read

    await scheduler.refreshUsage('platform:p1');

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('treats a new billing period (different spendResetsAt) as a reset to 0 for crossing purposes', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(5000, null, '2026-01-01T00:00:00Z') })], // old period, well above threshold
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, platform: { ...s.settings.notifications.platform, spendThresholdsCents: [100] } } },
    }));
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(200, null, '2026-02-01T00:00:00Z')); // new period, past 100 already

    await scheduler.refreshUsage('platform:p1');

    // Naively comparing 5000 -> 200 would look like spend went DOWN (no crossing); the new period
    // must be treated as starting from 0, so the 100 threshold is freshly crossed.
    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('notifies once when api_disabled_reason newly becomes non-null ("out of credits")', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500, null) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(500, 'out_of_credits'));

    await scheduler.refreshUsage('platform:p1');

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('does not re-notify api_disabled_reason once it was already set', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500, 'out_of_credits') })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(platformUsage(500, 'out_of_credits'));

    await scheduler.refreshUsage('platform:p1');

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('notifies once when a platform account transitions to sessionExpired', async () => {
    await seedState({
      accounts: [platformAccount({ usage: platformUsage(500) })],
      secrets: [{ accountId: 'platform:p1', sessionKey: 'pk1' }],
      activePlatformAccountId: 'platform:p1',
    });
    vi.mocked(claudeApi.fetchPlatformUsage).mockRejectedValue(new claudeApi.SessionExpiredError());

    await scheduler.refreshUsage('platform:p1');

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('serializes concurrent calls (e.g. an alarm tick racing a popup-triggered refresh) so a threshold is never notified twice', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(50) }],
      secrets: [{ accountId: 'a1', sessionKey: 'k1' }],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, notifications: { ...s.settings.notifications, claude: { ...s.settings.notifications.claude, usageThresholds: [80] } } },
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(90)); // crosses 80 exactly once

    const first = scheduler.refreshUsage('a1');
    const second = scheduler.refreshUsage('a1');
    await Promise.all([first, second]);

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalledTimes(1);
  });
});

describe('schedulePolling', () => {
  it('creates the alarm when none exists', async () => {
    mocks.chromeMock.alarms.get.mockResolvedValue(undefined);
    await scheduler.schedulePolling(5);
    expect(mocks.chromeMock.alarms.create).toHaveBeenCalledWith(scheduler.POLL_ALARM_NAME, { periodInMinutes: 5 });
  });

  it('does not recreate the alarm when the period is unchanged', async () => {
    mocks.chromeMock.alarms.get.mockResolvedValue({ name: scheduler.POLL_ALARM_NAME, periodInMinutes: 5, scheduledTime: 0 });
    await scheduler.schedulePolling(5);
    expect(mocks.chromeMock.alarms.create).not.toHaveBeenCalled();
  });

  it('recreates the alarm when the period changed', async () => {
    mocks.chromeMock.alarms.get.mockResolvedValue({ name: scheduler.POLL_ALARM_NAME, periodInMinutes: 5, scheduledTime: 0 });
    await scheduler.schedulePolling(10);
    expect(mocks.chromeMock.alarms.create).toHaveBeenCalledWith(scheduler.POLL_ALARM_NAME, { periodInMinutes: 10 });
  });

  it('clamps to an integer of at least 1 minute', async () => {
    mocks.chromeMock.alarms.get.mockResolvedValue(undefined);
    await scheduler.schedulePolling(0.4);
    expect(mocks.chromeMock.alarms.create).toHaveBeenCalledWith(scheduler.POLL_ALARM_NAME, { periodInMinutes: 1 });
    await scheduler.schedulePolling(5.6);
    expect(mocks.chromeMock.alarms.create).toHaveBeenCalledWith(scheduler.POLL_ALARM_NAME, { periodInMinutes: 6 });
  });
});

describe('updateBadge', () => {
  async function seedForBadge(utilization: number | null, showBadge = true) {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: utilization === null ? null : usage(utilization) }],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({ ...s, settings: { ...s.settings, showBadge, badgeMetric: 'fiveHour' } }));
  }

  it('shows green under 70%', async () => {
    await seedForBadge(50);
    await scheduler.updateBadge();
    expect(mocks.chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '50%' });
    expect(mocks.chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#16a34a' });
  });

  it('shows amber between 70% and 89%', async () => {
    await seedForBadge(75);
    await scheduler.updateBadge();
    expect(mocks.chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#d97706' });
  });

  it('shows red at 90% or above', async () => {
    await seedForBadge(95);
    await scheduler.updateBadge();
    expect(mocks.chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#dc2626' });
  });

  it('clears the badge when showBadge is false', async () => {
    await seedForBadge(95, false);
    await scheduler.updateBadge();
    expect(mocks.chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('clears the badge when there is no usage data yet', async () => {
    await seedForBadge(null);
    await scheduler.updateBadge();
    expect(mocks.chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('never uses a platform account for the badge, even if activeAccountId pointed at one', async () => {
    await seedState({ accounts: [platformAccount({ id: 'a1', usage: platformUsage(999) })], activeAccountId: 'a1' });
    await storage.updateState((s) => ({ ...s, settings: { ...s.settings, badgeMetric: 'fiveHour' } }));
    await scheduler.updateBadge();
    expect(mocks.chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });
});

describe('runPollCycle', () => {
  it('switches immediately for a non-confirm rule and records lastRuleFire', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(95) },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, autoSwitchEnabled: true },
      rules: [{ id: 'r1', name: 'R', enabled: true, condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'next' }, cooldownMinutes: 10, confirm: false }],
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(95));
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(5));

    await scheduler.runPollCycle();

    expect(session.switchAccount).toHaveBeenCalledWith('a2', 'rule', 'r1');
    const state = await storage.loadState();
    expect(state.lastRuleFire.r1).toBeTypeOf('number');
    expect(state.lastRuleFire.__global__).toBeTypeOf('number');
  });

  it('notifies about the automatic switch when notifications.claude.autoSwitch is on', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(95) },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, autoSwitchEnabled: true },
      rules: [{ id: 'r1', name: 'R', enabled: true, condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'next' }, cooldownMinutes: 10, confirm: false }],
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(95));
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(5));

    await scheduler.runPollCycle();

    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('does not notify about the automatic switch when autoSwitch notifications are off', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(95) },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, autoSwitchEnabled: true, notifications: { ...s.settings.notifications, claude: { ...s.settings.notifications.claude, autoSwitch: false } } },
      rules: [{ id: 'r1', name: 'R', enabled: true, condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'next' }, cooldownMinutes: 10, confirm: false }],
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(95));
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(5));

    await scheduler.runPollCycle();

    expect(mocks.chromeMock.notifications.create).not.toHaveBeenCalled();
  });

  it('creates a confirm notification instead of switching when rule.confirm is true', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(95) },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, autoSwitchEnabled: true },
      rules: [{ id: 'r1', name: 'R', enabled: true, condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'next' }, cooldownMinutes: 10, confirm: true }],
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(95));
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(5));

    await scheduler.runPollCycle();

    expect(session.switchAccount).not.toHaveBeenCalled();
    expect(mocks.chromeMock.notifications.create).toHaveBeenCalled();
  });

  it('does nothing when evaluateRules has no match', async () => {
    await seedState({ accounts: [], activeAccountId: null });
    await scheduler.runPollCycle();
    expect(session.switchAccount).not.toHaveBeenCalled();
  });
});

describe('confirm notification button handling', () => {
  async function triggerConfirmRule(): Promise<string> {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(95) },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: usage(5) },
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'k1' },
        { accountId: 'a2', sessionKey: 'k2' },
      ],
      activeAccountId: 'a1',
    });
    await storage.updateState((s) => ({
      ...s,
      settings: { ...s.settings, autoSwitchEnabled: true },
      rules: [{ id: 'r1', name: 'R', enabled: true, condition: { type: 'usageAbove', metric: 'fiveHour', percent: 80 }, target: { type: 'next' }, cooldownMinutes: 10, confirm: true }],
    }));
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(usage(95));
    vi.mocked(claudeApi.fetchUsageWithSessionOverride).mockResolvedValue(usage(5));
    await scheduler.runPollCycle();
    return mocks.chromeMock.notifications.create.mock.calls[0]![0] as string;
  }

  it('switches when "Switch now" is clicked and the target is still valid', async () => {
    const notificationId = await triggerConfirmRule();
    await mocks.listeners.onNotificationButtonClicked[0]!(notificationId, 0);
    expect(session.switchAccount).toHaveBeenCalledWith('a2', 'rule', 'r1');
  });

  it('does not switch on "Dismiss"', async () => {
    const notificationId = await triggerConfirmRule();
    await mocks.listeners.onNotificationButtonClicked[0]!(notificationId, 1);
    expect(session.switchAccount).not.toHaveBeenCalled();
  });

  it('re-validates the target and skips switching if it became paused before "Switch now" was clicked', async () => {
    const notificationId = await triggerConfirmRule();
    await storage.updateState((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === 'a2' ? { ...a, paused: true } : a)) }));
    await mocks.listeners.onNotificationButtonClicked[0]!(notificationId, 0);
    expect(session.switchAccount).not.toHaveBeenCalled();
  });

  it('swallows a switchAccount failure instead of throwing', async () => {
    const notificationId = await triggerConfirmRule();
    vi.mocked(session.switchAccount).mockRejectedValueOnce(new Error('boom'));
    await expect(mocks.listeners.onNotificationButtonClicked[0]!(notificationId, 0)).resolves.toBeUndefined();
  });

  it('discards the pending confirmation when the notification is closed without a click, so a later click is a no-op', async () => {
    const notificationId = await triggerConfirmRule();
    await mocks.listeners.onNotificationClosed[0]!(notificationId, true);
    await mocks.listeners.onNotificationButtonClicked[0]!(notificationId, 0);
    expect(session.switchAccount).not.toHaveBeenCalled();
  });
});

describe('switchToNext', () => {
  it('switches to the next eligible account and skips when none exist', async () => {
    await seedState({
      accounts: [
        { id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null },
        { id: 'a2', email: '', displayName: '', orgId: 'org2', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null },
      ],
      activeAccountId: 'a1',
    });
    await scheduler.switchToNext();
    expect(session.switchAccount).toHaveBeenCalledWith('a2', 'shortcut');
  });

  it('does nothing when there is no other eligible account', async () => {
    await seedState({ accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null }], activeAccountId: 'a1' });
    await scheduler.switchToNext();
    expect(session.switchAccount).not.toHaveBeenCalled();
  });

  it('rotates the platform account independently of claude.ai when service is "platform"', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null }, platformAccount({ id: 'platform:p1' }), platformAccount({ id: 'platform:p2' })],
      activeAccountId: 'a1',
      activePlatformAccountId: 'platform:p1',
    });
    await scheduler.switchToNext('platform');
    expect(session.switchAccount).toHaveBeenCalledWith('platform:p2', 'shortcut');
  });

  it('does not rotate into a claude.ai account when switching the platform service', async () => {
    await seedState({
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: '', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null }, platformAccount({ id: 'platform:p1' })],
      activeAccountId: 'a1',
      activePlatformAccountId: 'platform:p1',
    });
    await scheduler.switchToNext('platform'); // only one platform account -> no eligible target
    expect(session.switchAccount).not.toHaveBeenCalled();
  });
});
