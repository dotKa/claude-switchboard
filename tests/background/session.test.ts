import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import type { Account, AccountSecret } from '../../src/shared/types';
import type { OrgInfo } from '../../src/background/claudeApi';

vi.mock('../../src/background/claudeApi', () => ({
  fetchAccountInfo: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchUsage: vi.fn(),
  fetchPlatformUsage: vi.fn(),
}));

let mocks: ReturnType<typeof installChromeMock>;
let session: typeof import('../../src/background/session');
let claudeApi: typeof import('../../src/background/claudeApi');
let storage: typeof import('../../src/background/storage');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks = installChromeMock();
  session = await import('../../src/background/session');
  claudeApi = await import('../../src/background/claudeApi');
  storage = await import('../../src/background/storage');
});

function cookie(value: string, overrides: Partial<chrome.cookies.Cookie> = {}): chrome.cookies.Cookie {
  return {
    name: 'sessionKey',
    value,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: false,
    hostOnly: false,
    expirationDate: 1_900_000_000,
    storeId: '0',
    ...overrides,
  } as chrome.cookies.Cookie;
}

function org(overrides: Partial<OrgInfo> = {}): OrgInfo {
  return { id: 'org1', name: 'Org', plan: 'pro', capabilities: [], apiDisabledReason: null, ...overrides };
}

describe('cookieToSecret', () => {
  it('maps a cookie to an AccountSecret', () => {
    const c = cookie('tok-1', { expirationDate: 123 });
    expect(session.cookieToSecret('acc1', c)).toEqual({ accountId: 'acc1', sessionKey: 'tok-1', expirationDate: 123 });
  });
});

describe('captureCurrentAccount — claude.ai (default service)', () => {
  it('throws when there is no session cookie', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined);
    await expect(session.captureCurrentAccount()).rejects.toThrow(/session/i);
  });

  it('throws when the API returns an empty account id', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('tok-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: '', email: '', displayName: '' });
    await expect(session.captureCurrentAccount()).rejects.toThrow(/account id/i);
  });

  it('reads the cookie, calls the API, and upserts account + secret', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('tok-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'acc1', email: 'a@b.com', displayName: 'A' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org1', name: 'Org', plan: 'pro' })]);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue({
      fetchedAt: 1,
      limits: [],
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      extraUsage: null,
    });

    const account = await session.captureCurrentAccount();

    expect(account.id).toBe('acc1');
    expect(account.service).toBe('claude');
    expect(account.orgId).toBe('org1');
    expect(account.plan).toBe('pro');

    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('acc1');
    expect(state.activePlatformAccountId).toBeNull();
    expect(state.secrets).toEqual([{ accountId: 'acc1', sessionKey: 'tok-1', expirationDate: 1_900_000_000 }]);
  });

  it('preserves label/color/paused when re-capturing an existing account', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('tok-2'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'acc1', email: 'a@b.com', displayName: 'A' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org1', name: 'Org', plan: 'pro' })]);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(null as never);

    await storage.updateState((s) => ({
      ...s,
      accounts: [
        {
          id: 'acc1',
          email: 'a@b.com',
          displayName: 'A',
          orgId: 'org1',
          orgName: 'Org',
          plan: 'pro',
          label: 'Work',
          color: '#fff',
          paused: true,
          addedAt: 10,
          lastUsedAt: null,
          usage: null,
        } satisfies Account,
      ],
    }));

    const account = await session.captureCurrentAccount();
    expect(account.label).toBe('Work');
    expect(account.color).toBe('#fff');
    expect(account.paused).toBe(true);
    expect(account.addedAt).toBe(10);
  });

  it('picks the org matching the lastActiveOrg cookie over the first organization', async () => {
    mocks.chromeMock.cookies.get.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(name === 'lastActiveOrg' ? cookie('org2', { name: 'lastActiveOrg' }) : cookie('tok-1')),
    );
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'acc1', email: 'a@b.com', displayName: 'A' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org1', name: 'Org1', plan: 'free' }), org({ id: 'org2', name: 'Org2', plan: 'pro' })]);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount();
    expect(account.orgId).toBe('org2');
  });

  it('prefers a paid org over a free one when there is no lastActiveOrg match', async () => {
    mocks.chromeMock.cookies.get.mockImplementation(({ name }: { name: string }) => Promise.resolve(name === 'lastActiveOrg' ? undefined : cookie('tok-1')));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'acc1', email: 'a@b.com', displayName: 'A' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org1', name: 'Free', plan: 'free' }), org({ id: 'org2', name: 'Paid', plan: 'pro' })]);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount();
    expect(account.orgId).toBe('org2');
  });
});

describe('captureCurrentAccount — platform.claude.com', () => {
  it('prefixes the account id with "platform:" and sets activePlatformAccountId, not activeAccountId', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('ptok-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: 'a@b.com', displayName: 'A' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org1', name: 'API Org', plan: 'unknown', capabilities: ['api'] })]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount('platform');

    expect(account.id).toBe('platform:u1');
    expect(account.service).toBe('platform');
    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBe('platform:u1');
    expect(state.activeAccountId).toBeNull();
    expect(state.secrets).toEqual([{ accountId: 'platform:u1', sessionKey: 'ptok-1', expirationDate: 1_900_000_000 }]);
  });

  it('only considers orgs with the "api" capability, skipping a chat-only (claude.ai) org', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('ptok-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'chat-org', capabilities: ['chat'] }), org({ id: 'api-org', capabilities: ['api'] })]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount('platform');
    expect(account.orgId).toBe('api-org');
  });

  it('throws when no org has the "api" capability', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('ptok-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'chat-org', capabilities: ['chat'] })]);

    await expect(session.captureCurrentAccount('platform')).rejects.toThrow(/api/i);
  });

  it('reads the session cookie and lastActiveOrg cookie from the platform.claude.com origin', async () => {
    mocks.chromeMock.cookies.get.mockImplementation(({ url }: { url: string }) => Promise.resolve(url === 'https://platform.claude.com' ? cookie('ptok-1') : undefined));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'api-org', capabilities: ['api'] })]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount('platform');
    expect(account.id).toBe('platform:u1');
    expect(claudeApi.fetchAccountInfo).toHaveBeenCalledWith('https://platform.claude.com');
    expect(claudeApi.fetchOrganizations).toHaveBeenCalledWith('https://platform.claude.com');
  });
});

const FUTURE_EXPIRATION_A1 = Math.floor(Date.now() / 1000) + 100_000;
const FUTURE_EXPIRATION_A2 = Math.floor(Date.now() / 1000) + 200_000;

describe('switchAccount', () => {
  async function seedTwoAccounts() {
    await storage.updateState((s) => ({
      ...s,
      accounts: [
        { id: 'a1', email: 'a1@x.com', displayName: 'A1', orgId: 'org1', orgName: 'O', plan: 'pro', addedAt: 0, lastUsedAt: 0, usage: null } satisfies Account,
        { id: 'a2', email: 'a2@x.com', displayName: 'A2', orgId: 'org2', orgName: 'O', plan: 'pro', addedAt: 0, lastUsedAt: null, usage: null } satisfies Account,
      ],
      secrets: [
        { accountId: 'a1', sessionKey: 'secret-a1', expirationDate: FUTURE_EXPIRATION_A1 } satisfies AccountSecret,
        { accountId: 'a2', sessionKey: 'secret-a2', expirationDate: FUTURE_EXPIRATION_A2 } satisfies AccountSecret,
      ],
      activeAccountId: 'a1',
    }));
  }

  it('throws for an unknown target account', async () => {
    await seedTwoAccounts();
    await expect(session.switchAccount('does-not-exist')).rejects.toThrow();
  });

  it('refuses to switch to a sessionExpired target', async () => {
    await seedTwoAccounts();
    await storage.updateState((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === 'a2' ? { ...a, sessionExpired: true } : a)) }));
    await expect(session.switchAccount('a2')).rejects.toThrow(/expired/i);
    expect(mocks.chromeMock.cookies.set).not.toHaveBeenCalled();
  });

  it('refuses to switch to a target whose stored secret has already expired', async () => {
    await seedTwoAccounts();
    const pastEpochSeconds = Math.floor(Date.now() / 1000) - 3600;
    await storage.updateState((s) => ({ ...s, secrets: s.secrets.map((sec) => (sec.accountId === 'a2' ? { ...sec, expirationDate: pastEpochSeconds } : sec)) }));
    await expect(session.switchAccount('a2')).rejects.toThrow(/expired/i);
    expect(mocks.chromeMock.cookies.set).not.toHaveBeenCalled();
  });

  it('sets the target cookie, preserving attributes from the outgoing cookie', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1', { domain: '.claude.ai', sameSite: 'strict' }));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.switchAccount('a2');

    expect(mocks.chromeMock.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sessionKey', value: 'secret-a2', domain: '.claude.ai', sameSite: 'strict', expirationDate: FUTURE_EXPIRATION_A2 }),
    );
  });

  it('omits domain when the outgoing cookie is host-only, to preserve host-only scoping', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1', { hostOnly: true, domain: 'claude.ai' }));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.switchAccount('a2');

    const call = mocks.chromeMock.cookies.set.mock.calls[0]![0];
    expect(call).not.toHaveProperty('domain');
  });

  it('creates a host-only sessionKey cookie (no domain) when there is no outgoing cookie to copy attributes from', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined); // no live cookie of any kind right now

    await session.switchAccount('a2');

    const sessionCall = mocks.chromeMock.cookies.set.mock.calls.find((c) => c[0].name === 'sessionKey')![0];
    expect(sessionCall).not.toHaveProperty('domain');
  });

  it('creates a host-only lastActiveOrg cookie (no domain) when there is no existing one to copy attributes from', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined);

    await session.switchAccount('a2');

    const lastActiveOrgCall = mocks.chromeMock.cookies.set.mock.calls.find((c) => c[0].name === 'lastActiveOrg')![0];
    expect(lastActiveOrgCall).not.toHaveProperty('domain');
  });

  it('refreshes the outgoing account secret once the live cookie is confirmed to belong to it', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('rotated-a1-value'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.switchAccount('a2');

    const state = await storage.loadState();
    const refreshed = state.secrets.find((s) => s.accountId === 'a1');
    expect(refreshed?.sessionKey).toBe('rotated-a1-value');
  });

  it('updates the ACTUAL owning account secret, not activeAccountId, when the live cookie belongs to a different saved account', async () => {
    await seedTwoAccounts();
    // A third saved account (a3) whose session happens to be the one live in the browser right now —
    // e.g. the user logged into claude.ai as a3 directly, outside the extension.
    await storage.updateState((s) => ({
      ...s,
      accounts: [...s.accounts, { id: 'a3', email: 'a3@x.com', displayName: 'A3', orgId: 'org3', orgName: 'O', plan: 'pro', addedAt: 0, lastUsedAt: null, usage: null }],
      secrets: [...s.secrets, { accountId: 'a3', sessionKey: 'stale-a3-value' }],
    }));
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('live-a3-value'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a3', email: '', displayName: '' });

    await session.switchAccount('a2');

    const state = await storage.loadState();
    expect(state.secrets.find((s) => s.accountId === 'a3')?.sessionKey).toBe('live-a3-value');
    expect(state.secrets.find((s) => s.accountId === 'a1')?.sessionKey).toBe('secret-a1'); // untouched, not clobbered
  });

  it('does not overwrite any secret when the live cookie cannot be attributed to a saved account', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('some-unsaved-value'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'unknown-account', email: '', displayName: '' });

    await session.switchAccount('a2');

    const state = await storage.loadState();
    expect(state.secrets.find((s) => s.accountId === 'a1')?.sessionKey).toBe('secret-a1');
  });

  it('does not overwrite any secret when ownership cannot be verified (API call fails)', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('whatever'));
    vi.mocked(claudeApi.fetchAccountInfo).mockRejectedValue(new Error('network down'));

    await session.switchAccount('a2'); // must still succeed in switching

    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('a2');
    expect(state.secrets.find((s) => s.accountId === 'a1')?.sessionKey).toBe('secret-a1');
  });

  it('records a history entry (tagged with the claude service) and updates activeAccountId', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.switchAccount('a2');

    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('a2');
    expect(state.history[0]).toMatchObject({ service: 'claude', fromAccountId: 'a1', toAccountId: 'a2', reason: 'manual' });
  });

  it('parks open claude.ai tabs on the switching page, then sends them to the claude.ai landing page', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });
    mocks.chromeMock.tabs.query.mockResolvedValue([{ id: 7 }]);

    await session.switchAccount('a2');

    expect(mocks.chromeMock.tabs.query).toHaveBeenCalledWith({ url: 'https://claude.ai/*' });
    expect(mocks.chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: 'chrome-extension://test-extension-id/switching/index.html' });
    expect(mocks.chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: 'https://claude.ai/new' });
  });

  it('does not treat the OLD page reporting complete as parked: waits for the switching page to load before touching cookies', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });
    mocks.chromeMock.tabs.query.mockResolvedValue([{ id: 7 }]);
    // Right after tabs.update the tab still describes the old claude.ai page as complete.
    mocks.chromeMock.tabs.get.mockResolvedValue({ status: 'complete', url: 'https://claude.ai/chat/abc' });
    let onUpdated: ((id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) | undefined;
    mocks.chromeMock.tabs.onUpdated.addListener.mockImplementation((cb: typeof onUpdated) => {
      onUpdated = cb;
    });

    const switching = session.switchAccount('a2');
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.chromeMock.cookies.set).not.toHaveBeenCalled();

    onUpdated?.(7, { status: 'complete' }, { status: 'complete', url: 'chrome-extension://test-extension-id/switching/index.html' } as chrome.tabs.Tab);
    await switching;
    expect(mocks.chromeMock.cookies.set).toHaveBeenCalled();
  });

  it('parks tabs BEFORE setting the target cookie, and only sends them to the landing page AFTER', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });
    mocks.chromeMock.tabs.query.mockResolvedValue([{ id: 7 }]);

    await session.switchAccount('a2');

    const parkCallIndex = mocks.chromeMock.tabs.update.mock.calls.findIndex((c) => c[1].url.endsWith('switching/index.html'));
    const landingCallIndex = mocks.chromeMock.tabs.update.mock.calls.findIndex((c) => c[1].url === 'https://claude.ai/new');
    const cookieSetCallIndex = mocks.chromeMock.cookies.set.mock.invocationCallOrder[0]!;
    expect(mocks.chromeMock.tabs.update.mock.invocationCallOrder[parkCallIndex]).toBeLessThan(cookieSetCallIndex);
    expect(mocks.chromeMock.tabs.update.mock.invocationCallOrder[landingCallIndex]).toBeGreaterThan(cookieSetCallIndex);
  });

  it('clears the service origin\'s site storage, but never its cookies', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.switchAccount('a2');

    expect(mocks.chromeMock.browsingData.remove).toHaveBeenCalledWith(
      { origins: ['https://claude.ai'] },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
    );
    const [, dataTypes] = mocks.chromeMock.browsingData.remove.mock.calls[0]!;
    expect(dataTypes).not.toHaveProperty('cookies');
  });

  it('does not try to restore a landing page when there are no open tabs to begin with', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });
    mocks.chromeMock.tabs.query.mockResolvedValue([]);

    await session.switchAccount('a2');

    expect(mocks.chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('still succeeds even if clearing site storage fails', async () => {
    await seedTwoAccounts();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });
    mocks.chromeMock.browsingData.remove.mockRejectedValue(new Error('boom'));

    await expect(session.switchAccount('a2')).resolves.toBeUndefined();
    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('a2');
  });
});

describe('switchAccount — platform account', () => {
  async function seedPlatformAccount() {
    await storage.updateState((s) => ({
      ...s,
      accounts: [
        { id: 'platform:u1', service: 'platform', email: 'u1@x.com', displayName: 'U1', orgId: 'org1', orgName: 'O', plan: 'unknown', addedAt: 0, lastUsedAt: null, usage: null } satisfies Account,
        { id: 'platform:u2', service: 'platform', email: 'u2@x.com', displayName: 'U2', orgId: 'org2', orgName: 'O', plan: 'unknown', addedAt: 0, lastUsedAt: null, usage: null } satisfies Account,
      ],
      secrets: [
        { accountId: 'platform:u1', sessionKey: 'p-secret-1' } satisfies AccountSecret,
        { accountId: 'platform:u2', sessionKey: 'p-secret-2' } satisfies AccountSecret,
      ],
      activePlatformAccountId: 'platform:u1',
    }));
  }

  it('sets the cookie on the platform.claude.com origin and updates activePlatformAccountId, not activeAccountId', async () => {
    await seedPlatformAccount();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('p-secret-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });

    await session.switchAccount('platform:u2');

    expect(mocks.chromeMock.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://platform.claude.com', value: 'p-secret-2' }));
    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBe('platform:u2');
    expect(state.activeAccountId).toBeNull();
  });

  it('only parks platform.claude.com tabs, not claude.ai ones, and lands them on platform.claude.com', async () => {
    await seedPlatformAccount();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('p-secret-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });
    mocks.chromeMock.tabs.query.mockResolvedValue([{ id: 9 }]);

    await session.switchAccount('platform:u2');

    expect(mocks.chromeMock.tabs.query).toHaveBeenCalledWith({ url: 'https://platform.claude.com/*' });
    expect(mocks.chromeMock.tabs.update).toHaveBeenCalledWith(9, { url: 'https://platform.claude.com/' });
  });

  it('clears platform.claude.com site storage, but never its cookies', async () => {
    await seedPlatformAccount();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('p-secret-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });

    await session.switchAccount('platform:u2');

    expect(mocks.chromeMock.browsingData.remove).toHaveBeenCalledWith(
      { origins: ['https://platform.claude.com'] },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
    );
  });

  it('tags the history event with service: "platform"', async () => {
    await seedPlatformAccount();
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('p-secret-1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });

    await session.switchAccount('platform:u2');

    const state = await storage.loadState();
    expect(state.history[0]).toMatchObject({ service: 'platform', fromAccountId: 'platform:u1', toAccountId: 'platform:u2' });
  });
});

describe('addAccountFlow', () => {
  it('removes the cookie, marks pendingAddAccount, and opens the login tab when there are no open tabs', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.addAccountFlow();

    expect(mocks.chromeMock.cookies.remove).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://claude.ai' }));
    expect(mocks.chromeMock.tabs.create).toHaveBeenCalledWith({ url: 'https://claude.ai/login' });
    await expect(session.isPendingAddAccount('claude')).resolves.toBe(true);
  });

  it('parks any open claude.ai tabs before removing the cookie, then navigates them to the login page instead of opening a new tab', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('secret-a1'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });
    mocks.chromeMock.tabs.query.mockResolvedValue([{ id: 7 }]);

    await session.addAccountFlow();

    expect(mocks.chromeMock.tabs.query).toHaveBeenCalledWith({ url: 'https://claude.ai/*' });
    expect(mocks.chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: 'chrome-extension://test-extension-id/switching/index.html' });
    expect(mocks.chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: 'https://claude.ai/login' });
    expect(mocks.chromeMock.tabs.create).not.toHaveBeenCalled();

    const parkCallIndex = mocks.chromeMock.tabs.update.mock.calls.findIndex((c) => c[1].url.endsWith('switching/index.html'));
    const cookieRemoveCallIndex = mocks.chromeMock.cookies.remove.mock.invocationCallOrder[0]!;
    expect(mocks.chromeMock.tabs.update.mock.invocationCallOrder[parkCallIndex]).toBeLessThan(cookieRemoveCallIndex);
  });

  it('clears site storage for the service as part of adding an account', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined);

    await session.addAccountFlow();

    expect(mocks.chromeMock.browsingData.remove).toHaveBeenCalledWith(
      { origins: ['https://claude.ai'] },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
    );
  });

  it('refreshes the current account secret once ownership of the live cookie is confirmed', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: 'O', plan: 'pro', addedAt: 0, lastUsedAt: null, usage: null }],
      secrets: [{ accountId: 'a1', sessionKey: 'old-value' }],
      activeAccountId: 'a1',
    }));
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('rotated-value'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'a1', email: '', displayName: '' });

    await session.addAccountFlow();

    const state = await storage.loadState();
    expect(state.secrets.find((s) => s.accountId === 'a1')?.sessionKey).toBe('rotated-value');
  });

  it('does not overwrite any secret when the live cookie belongs to no saved account', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [{ id: 'a1', email: '', displayName: '', orgId: 'org1', orgName: 'O', plan: 'pro', addedAt: 0, lastUsedAt: null, usage: null }],
      secrets: [{ accountId: 'a1', sessionKey: 'old-value' }],
      activeAccountId: 'a1',
    }));
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('some-other-login'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'someone-else', email: '', displayName: '' });

    await session.addAccountFlow();

    const state = await storage.loadState();
    expect(state.secrets.find((s) => s.accountId === 'a1')?.sessionKey).toBe('old-value');
  });

  it('opens the platform.claude.com login page and removes that origin\'s cookie for service "platform"', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined);

    await session.addAccountFlow('platform');

    expect(mocks.chromeMock.cookies.remove).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://platform.claude.com' }));
    expect(mocks.chromeMock.tabs.create).toHaveBeenCalledWith({ url: 'https://platform.claude.com/login' });
    await expect(session.isPendingAddAccount('platform')).resolves.toBe(true);
    await expect(session.isPendingAddAccount('claude')).resolves.toBe(false);
  });
});

describe('isSessionUnsaved', () => {
  it('is false when there is no live cookie', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined);
    await expect(session.isSessionUnsaved('claude', { secrets: [] })).resolves.toBe(false);
  });

  it('is true when the live cookie matches no saved secret', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('unknown'));
    await expect(session.isSessionUnsaved('claude', { secrets: [{ accountId: 'a1', sessionKey: 'known' }] })).resolves.toBe(true);
  });

  it('is false when the live cookie matches a saved secret', async () => {
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('known'));
    await expect(session.isSessionUnsaved('claude', { secrets: [{ accountId: 'a1', sessionKey: 'known' }] })).resolves.toBe(false);
  });
});

describe('handleSessionCookieChanged', () => {
  it('does nothing when the cookie value is already saved', async () => {
    await storage.updateState((s) => ({ ...s, secrets: [{ accountId: 'a1', sessionKey: 'known' }] }));
    await session.handleSessionCookieChanged(cookie('known'), 'claude');
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled();
  });

  it('does nothing for a new cookie when no add-account flow is pending', async () => {
    await session.handleSessionCookieChanged(cookie('brand-new'), 'claude');
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled();
  });

  it('auto-captures the account when a new cookie appears while an add-account flow is pending', async () => {
    await session.setPendingAddAccount('claude', true);
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'acc2', email: 'b@b.com', displayName: 'B' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org2', name: 'Org2', plan: 'free' })]);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(null as never);
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('brand-new'));

    await session.handleSessionCookieChanged(cookie('brand-new'), 'claude');

    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('acc2');
    await expect(session.isPendingAddAccount('claude')).resolves.toBe(false);
  });

  it('a platform cookie change does not consult or clear the claude pending flag', async () => {
    await session.setPendingAddAccount('claude', true);
    await session.handleSessionCookieChanged(cookie('brand-new-platform'), 'platform');
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled(); // no platform flow was pending
    await expect(session.isPendingAddAccount('claude')).resolves.toBe(true); // untouched
  });

  it('auto-captures a platform account when a new cookie appears while a platform add-account flow is pending', async () => {
    await session.setPendingAddAccount('platform', true);
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u3', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org3', capabilities: ['api'] })]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('new-platform-cookie'));

    await session.handleSessionCookieChanged(cookie('new-platform-cookie'), 'platform');

    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBe('platform:u3');
    await expect(session.isPendingAddAccount('platform')).resolves.toBe(false);
  });
});

describe('cookies.onChanged routing (the real registered listener, not handleSessionCookieChanged directly)', () => {
  async function fireCookieChange(c: chrome.cookies.Cookie): Promise<void> {
    const listener = mocks.listeners.onCookiesChanged[0]!;
    await listener({ removed: false, cookie: c } as never);
  }

  it('routes a platform sessionKey cookie scoped to the wider .claude.com domain to the platform service', async () => {
    await session.setPendingAddAccount('platform', true);
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u9', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org9', capabilities: ['api'] })]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);
    const wideCookie = cookie('wide-domain-platform-cookie', { domain: '.claude.com' });
    mocks.chromeMock.cookies.get.mockResolvedValue(wideCookie);

    await fireCookieChange(wideCookie);

    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBe('platform:u9');
  });

  it('still routes a platform.claude.com-scoped (host-only) cookie to platform too', async () => {
    await session.setPendingAddAccount('platform', true);
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u10', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org({ id: 'org10', capabilities: ['api'] })]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);
    const hostOnlyCookie = cookie('host-only-platform-cookie', { domain: 'platform.claude.com', hostOnly: true });
    mocks.chromeMock.cookies.get.mockResolvedValue(hostOnlyCookie);

    await fireCookieChange(hostOnlyCookie);

    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBe('platform:u10');
  });

  it('does not treat a .claude.com cookie as belonging to claude.ai', async () => {
    await session.setPendingAddAccount('claude', true);
    await fireCookieChange(cookie('some-value', { domain: '.claude.com' }));
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled(); // claude's pending flow never got consulted
    await expect(session.isPendingAddAccount('claude')).resolves.toBe(true); // untouched
  });

  it('ignores a cookie removal', async () => {
    await session.setPendingAddAccount('claude', true);
    const listener = mocks.listeners.onCookiesChanged[0]!;
    await listener({ removed: true, cookie: cookie('removed-value') } as never);
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled();
  });

  it('ignores a cookie with an unrelated name', async () => {
    await session.setPendingAddAccount('claude', true);
    await fireCookieChange(cookie('irrelevant', { name: 'sessionKeyLC' }));
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled();
  });
});

describe('platform optional host permission gating', () => {
  function org(overrides: Partial<OrgInfo> = {}): OrgInfo {
    return { id: 'org1', name: 'Org', plan: 'pro', capabilities: ['api'], apiDisabledReason: null, ...overrides };
  }

  it('getCurrentSessionCookie("platform") returns null without calling chrome.cookies.get when the permission is missing', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);

    await expect(session.getCurrentSessionCookie('platform')).resolves.toBeNull();

    expect(mocks.chromeMock.cookies.get).not.toHaveBeenCalled();
  });

  it('getCurrentSessionCookie("claude") is unaffected by the platform permission', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('tok'));

    await expect(session.getCurrentSessionCookie('claude')).resolves.toMatchObject({ value: 'tok' });
  });

  it('captureCurrentAccount("platform") throws a clear error without touching cookies, when the permission is missing', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);

    await expect(session.captureCurrentAccount('platform')).rejects.toThrow(/allow access to platform\.claude\.com/i);
    expect(mocks.chromeMock.cookies.get).not.toHaveBeenCalled();
    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled();
  });

  it('captureCurrentAccount("claude") is unaffected by the platform permission', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('tok'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'acc1', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org()]);
    vi.mocked(claudeApi.fetchUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount('claude');
    expect(account.id).toBe('acc1');
  });

  it('captureCurrentAccount("platform") succeeds once the permission is granted', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(true);
    mocks.chromeMock.cookies.get.mockResolvedValue(cookie('ptok'));
    vi.mocked(claudeApi.fetchAccountInfo).mockResolvedValue({ id: 'u1', email: '', displayName: '' });
    vi.mocked(claudeApi.fetchOrganizations).mockResolvedValue([org()]);
    vi.mocked(claudeApi.fetchPlatformUsage).mockResolvedValue(null as never);

    const account = await session.captureCurrentAccount('platform');
    expect(account.id).toBe('platform:u1');
  });

  it('addAccountFlow("platform") throws a clear error without touching cookies, when the permission is missing', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);

    await expect(session.addAccountFlow('platform')).rejects.toThrow(/allow access to platform\.claude\.com/i);
    expect(mocks.chromeMock.cookies.get).not.toHaveBeenCalled();
    expect(mocks.chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(mocks.chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('addAccountFlow("claude") is unaffected by the platform permission', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);
    mocks.chromeMock.cookies.get.mockResolvedValue(undefined);

    await session.addAccountFlow('claude');

    expect(mocks.chromeMock.tabs.create).toHaveBeenCalledWith({ url: 'https://claude.ai/login' });
  });

  it('switchAccount to a platform account throws a clear error without touching cookies, when the permission is missing', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [{ id: 'platform:u1', service: 'platform', email: '', displayName: '', orgId: 'org1', orgName: 'O', plan: 'unknown', addedAt: 0, lastUsedAt: null, usage: null }],
      secrets: [{ accountId: 'platform:u1', sessionKey: 'p1' }],
    }));
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);

    await expect(session.switchAccount('platform:u1')).rejects.toThrow(/allow access to platform\.claude\.com/i);
    expect(mocks.chromeMock.cookies.set).not.toHaveBeenCalled();
  });

  it('a platform cookie change is a no-op when the permission is missing, even if an add-account flow was pending', async () => {
    await session.setPendingAddAccount('platform', true);
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);

    await session.handleSessionCookieChanged(cookie('new-platform-cookie'), 'platform');

    expect(claudeApi.fetchAccountInfo).not.toHaveBeenCalled();
  });
});
