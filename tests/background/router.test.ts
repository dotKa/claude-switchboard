import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import type { Request, Response } from '../../src/shared/messages';
import type { Account } from '../../src/shared/types';

vi.mock('../../src/background/session', () => {
  const getCurrentSessionCookie = vi.fn().mockResolvedValue(null);
  return {
    captureCurrentAccount: vi.fn(),
    switchAccount: vi.fn().mockResolvedValue(undefined),
    addAccountFlow: vi.fn().mockResolvedValue(undefined),
    getCurrentSessionCookie,
    isSessionUnsaved: vi.fn(async (service: string, state: { secrets: { sessionKey: string }[] }) => {
      const cookie = await getCurrentSessionCookie(service);
      if (!cookie) return false;
      return !state.secrets.some((s) => s.sessionKey === cookie.value);
    }),
  };
});

vi.mock('../../src/background/scheduler', () => ({
  refreshUsage: vi.fn().mockResolvedValue(undefined),
  updateBadge: vi.fn().mockResolvedValue(undefined),
  schedulePolling: vi.fn().mockResolvedValue(undefined),
  switchToNext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/background/permissions', () => ({
  hasPlatformPermission: vi.fn().mockResolvedValue(true),
}));

let mocks: ReturnType<typeof installChromeMock>;
let storage: typeof import('../../src/background/storage');
let session: typeof import('../../src/background/session');
let scheduler: typeof import('../../src/background/scheduler');
let permissions: typeof import('../../src/background/permissions');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks = installChromeMock();
  await import('../../src/background/router');
  storage = await import('../../src/background/storage');
  session = await import('../../src/background/session');
  scheduler = await import('../../src/background/scheduler');
  permissions = await import('../../src/background/permissions');
  // vi.clearAllMocks() clears call history but NOT a custom mockImplementation/mockResolvedValue
  // from a previous test — reset this one to its sane default explicitly so tests stay independent.
  vi.mocked(session.getCurrentSessionCookie).mockResolvedValue(null);
  vi.mocked(permissions.hasPlatformPermission).mockResolvedValue(true);
  vi.mocked(session.isSessionUnsaved).mockImplementation(async (service: string, state: { secrets: { sessionKey: string }[] }) => {
    const cookie = await session.getCurrentSessionCookie(service as never);
    if (!cookie) return false;
    return !state.secrets.some((s) => s.sessionKey === cookie.value);
  });
});

function account(id: string): Account {
  return { id, email: `${id}@x.com`, displayName: id, orgId: `org-${id}`, orgName: 'O', plan: 'pro', addedAt: 0, lastUsedAt: null, usage: null };
}

/** Invokes the single registered chrome.runtime.onMessage listener as Chrome would. */
async function send<T extends Request>(req: T, sender: chrome.runtime.MessageSender = { id: 'test-extension-id' }): Promise<Response<T['type']>> {
  const listener = mocks.listeners.onMessage[0]!;
  return new Promise((resolve) => {
    const keepOpen = listener(req, sender, (res: unknown) => resolve(res as Response<T['type']>));
    expect(keepOpen).toBe(true);
  });
}

describe('getState', () => {
  it('returns a secret-free PublicState', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1')], secrets: [{ accountId: 'a1', sessionKey: 'shh' }], activeAccountId: 'a1' }));
    const res = await send({ type: 'getState' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.accounts).toEqual([account('a1')]);
    expect(JSON.stringify(res.data)).not.toContain('shh');
  });

  it('reports unsavedSessionDetected when a cookie exists that matches no saved secret', async () => {
    vi.mocked(session.getCurrentSessionCookie).mockResolvedValue({ value: 'unknown-token' } as chrome.cookies.Cookie);
    const res = await send({ type: 'getState' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.unsavedSessionDetected).toBe(true);
  });

  it('reports no unsaved session when the cookie matches a saved secret', async () => {
    await storage.updateState((s) => ({ ...s, secrets: [{ accountId: 'a1', sessionKey: 'known' }] }));
    vi.mocked(session.getCurrentSessionCookie).mockResolvedValue({ value: 'known' } as chrome.cookies.Cookie);
    const res = await send({ type: 'getState' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.unsavedSessionDetected).toBe(false);
  });

  it('includes activePlatformAccountId and unsavedPlatformSessionDetected', async () => {
    await storage.updateState((s) => ({ ...s, activePlatformAccountId: 'platform:u1', secrets: [{ accountId: 'platform:u1', sessionKey: 'known' }] }));
    vi.mocked(session.getCurrentSessionCookie).mockImplementation((service?: string) =>
      Promise.resolve(service === 'platform' ? ({ value: 'unknown-platform-token' } as chrome.cookies.Cookie) : null),
    );
    const res = await send({ type: 'getState' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.activePlatformAccountId).toBe('platform:u1');
    expect(res.data.unsavedPlatformSessionDetected).toBe(true);
    expect(res.data.unsavedSessionDetected).toBe(false); // the claude.ai cookie check is independent
  });

  it('includes platformPermission: true when the optional host permission is granted', async () => {
    const res = await send({ type: 'getState' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.platformPermission).toBe(true);
  });

  it('includes platformPermission: false and skips platform without crashing when the permission is missing', async () => {
    vi.mocked(permissions.hasPlatformPermission).mockResolvedValue(false);
    const res = await send({ type: 'getState' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.platformPermission).toBe(false);
    expect(res.data.unsavedPlatformSessionDetected).toBe(false);
  });

  it('getState never crashes because one service failed — isolates each service in its own try/catch', async () => {
    vi.mocked(session.isSessionUnsaved).mockImplementation(async (service: string) => {
      if (service === 'platform') throw new Error('boom');
      return false;
    });
    vi.mocked(permissions.hasPlatformPermission).mockRejectedValue(new Error('boom'));

    const res = await send({ type: 'getState' });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.unsavedPlatformSessionDetected).toBe(false);
    expect(res.data.platformPermission).toBe(false);
  });
});

describe('request dispatch', () => {
  it('switchAccount calls session.switchAccount with the account id', async () => {
    const res = await send({ type: 'switchAccount', accountId: 'a2' });
    expect(res.ok).toBe(true);
    expect(session.switchAccount).toHaveBeenCalledWith('a2', 'manual');
  });

  it('switchNext calls scheduler.switchToNext with the default service "claude"', async () => {
    await send({ type: 'switchNext' });
    expect(scheduler.switchToNext).toHaveBeenCalledWith('claude');
  });

  it('switchNext passes through an explicit service', async () => {
    await send({ type: 'switchNext', service: 'platform' });
    expect(scheduler.switchToNext).toHaveBeenCalledWith('platform');
  });

  it('captureCurrentAccount returns the captured account', async () => {
    vi.mocked(session.captureCurrentAccount).mockResolvedValue(account('a1'));
    const res = await send({ type: 'captureCurrentAccount' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data).toEqual(account('a1'));
    expect(session.captureCurrentAccount).toHaveBeenCalledWith('claude');
  });

  it('captureCurrentAccount passes through an explicit service', async () => {
    vi.mocked(session.captureCurrentAccount).mockResolvedValue(account('platform:u1'));
    await send({ type: 'captureCurrentAccount', service: 'platform' });
    expect(session.captureCurrentAccount).toHaveBeenCalledWith('platform');
  });

  it('removeAccount deletes the account, its secret, and clears activeAccountId if it was active', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1'), account('a2')], secrets: [{ accountId: 'a1', sessionKey: 'x' }], activeAccountId: 'a1' }));
    await send({ type: 'removeAccount', accountId: 'a1' });
    const state = await storage.loadState();
    expect(state.accounts.map((a) => a.id)).toEqual(['a2']);
    expect(state.secrets).toEqual([]);
    expect(state.activeAccountId).toBeNull();
  });

  it('removeAccount leaves activeAccountId alone when removing a different account', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1'), account('a2')], activeAccountId: 'a1' }));
    await send({ type: 'removeAccount', accountId: 'a2' });
    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('a1');
  });

  it('updateAccount patches only label/color/paused', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1')] }));
    await send({ type: 'updateAccount', accountId: 'a1', patch: { label: 'Personal', paused: true } });
    const state = await storage.loadState();
    expect(state.accounts[0]).toMatchObject({ label: 'Personal', paused: true, email: 'a1@x.com' });
  });

  it('refreshUsage delegates to scheduler.refreshUsage with the optional accountId', async () => {
    await send({ type: 'refreshUsage', accountId: 'a1' });
    expect(scheduler.refreshUsage).toHaveBeenCalledWith('a1');
  });

  it('addAccountFlow delegates to session.addAccountFlow with the default service "claude"', async () => {
    const res = await send({ type: 'addAccountFlow' });
    expect(session.addAccountFlow).toHaveBeenCalledWith('claude');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data).toEqual({ ok: true });
  });

  it('addAccountFlow passes through an explicit service', async () => {
    await send({ type: 'addAccountFlow', service: 'platform' });
    expect(session.addAccountFlow).toHaveBeenCalledWith('platform');
  });

  it('saveRules persists the rule list', async () => {
    const rules = [{ id: 'r1', name: 'R', enabled: true, condition: { type: 'limitReached' as const }, target: { type: 'next' as const }, cooldownMinutes: 5, confirm: false }];
    await send({ type: 'saveRules', rules });
    const state = await storage.loadState();
    expect(state.rules).toEqual(rules);
  });

  it('saveSettings merges settings, reschedules polling, and updates the badge', async () => {
    await send({ type: 'saveSettings', settings: { pollIntervalMinutes: 20 } });
    const state = await storage.loadState();
    expect(state.settings.pollIntervalMinutes).toBe(20);
    expect(scheduler.schedulePolling).toHaveBeenCalledWith(20);
    expect(scheduler.updateBadge).toHaveBeenCalled();
  });

  it('saveSettings deep-merges a partial notifications patch without wiping the other service', async () => {
    await send({ type: 'saveSettings', settings: { notifications: { claude: { enabled: false } } } as never });
    const state = await storage.loadState();
    expect(state.settings.notifications.claude.enabled).toBe(false);
    expect(state.settings.notifications.platform.enabled).toBe(true); // untouched default
  });

  it('returns ok:false with the error message when a handler throws', async () => {
    vi.mocked(session.switchAccount).mockRejectedValueOnce(new Error('boom'));
    const res = await send({ type: 'switchAccount', accountId: 'nope' });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });

  it('broadcasts stateChanged after a mutating request', async () => {
    await send({ type: 'updateAccount', accountId: 'a1', patch: { paused: true } });
    await vi.waitFor(() => expect(mocks.chromeMock.runtime.sendMessage).toHaveBeenCalled());
    const [msg] = mocks.chromeMock.runtime.sendMessage.mock.calls.at(-1)!;
    expect(msg).toMatchObject({ type: 'stateChanged' });
  });

  it('rejects an unrecognized request type with ok:false and does not broadcast', async () => {
    const res = await send({ type: 'notARealRequestType' } as unknown as Request);
    expect(res.ok).toBe(false);
    expect(mocks.chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a message whose sender is not this extension', async () => {
    const res = await send({ type: 'switchAccount', accountId: 'a2' }, { id: 'some-other-extension-id' });
    expect(res.ok).toBe(false);
    expect(session.switchAccount).not.toHaveBeenCalled();
  });

  it('updateAccount ignores keys outside the label/color/paused whitelist', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1')] }));
    await send({ type: 'updateAccount', accountId: 'a1', patch: { label: 'Ok', id: 'hacked', usage: { fetchedAt: 1 } } as never });
    const state = await storage.loadState();
    expect(state.accounts[0]).toMatchObject({ id: 'a1', label: 'Ok', usage: null });
  });

  it('updateAccount ignores a wrong-typed value for a whitelisted key', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [{ ...account('a1'), paused: false }] }));
    await send({ type: 'updateAccount', accountId: 'a1', patch: { paused: 'yes' } as never });
    const state = await storage.loadState();
    expect(state.accounts[0]!.paused).toBe(false);
  });
});

describe('exportData / importData', () => {
  it('exports accounts/rules/settings/history without secrets by default', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1')], secrets: [{ accountId: 'a1', sessionKey: 'shh' }] }));
    const res = await send({ type: 'exportData', includeSecrets: false });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.payload).not.toContain('shh');
    const parsed = JSON.parse(res.data.payload);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.secrets).toBeUndefined();
  });

  it('refuses to export secrets without a passphrase', async () => {
    const res = await send({ type: 'exportData', includeSecrets: true });
    expect(res).toMatchObject({ ok: false });
  });

  it('round-trips encrypted secrets through export + import with the right passphrase', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1')], secrets: [{ accountId: 'a1', sessionKey: 'top-secret' }] }));
    const exportRes = await send({ type: 'exportData', includeSecrets: true, passphrase: 'correct horse' });
    if (!exportRes.ok) throw new Error('unreachable');
    expect(exportRes.data.payload).not.toContain('top-secret');

    await storage.updateState((s) => ({ ...s, secrets: [] }));
    const importRes = await send({ type: 'importData', payload: exportRes.data.payload, passphrase: 'correct horse' });
    expect(importRes.ok).toBe(true);

    const state = await storage.loadState();
    expect(state.secrets).toEqual([{ accountId: 'a1', sessionKey: 'top-secret' }]);
  });

  it('rejects importing encrypted secrets with the wrong passphrase', async () => {
    await storage.updateState((s) => ({ ...s, secrets: [{ accountId: 'a1', sessionKey: 'top-secret' }] }));
    const exportRes = await send({ type: 'exportData', includeSecrets: true, passphrase: 'right' });
    if (!exportRes.ok) throw new Error('unreachable');
    const importRes = await send({ type: 'importData', payload: exportRes.data.payload, passphrase: 'wrong' });
    expect(importRes.ok).toBe(false);
  });

  it('imports accounts/rules/settings even without touching secrets when none are present', async () => {
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.accounts = [account('imported')];
    const importRes = await send({ type: 'importData', payload: JSON.stringify(payload) });
    expect(importRes.ok).toBe(true);
    const state = await storage.loadState();
    expect(state.accounts.map((a) => a.id)).toEqual(['imported']);
  });

  it('does not mutate any state when decryption fails (atomic import)', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [account('a1')],
      secrets: [{ accountId: 'a1', sessionKey: 'top-secret' }],
      settings: { ...s.settings, pollIntervalMinutes: 5 },
    }));
    const exportRes = await send({ type: 'exportData', includeSecrets: true, passphrase: 'right' });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.accounts = [account('should-not-appear')];
    payload.settings = { pollIntervalMinutes: 99 };

    const importRes = await send({ type: 'importData', payload: JSON.stringify(payload), passphrase: 'wrong' });

    expect(importRes.ok).toBe(false);
    const state = await storage.loadState();
    expect(state.accounts.map((a) => a.id)).toEqual(['a1']); // untouched
    expect(state.settings.pollIntervalMinutes).toBe(5); // untouched
  });

  it('merges imported secrets by accountId for a surviving account, preferring the import value', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [account('a1')],
      secrets: [{ accountId: 'a1', sessionKey: 'a1-original' }],
    }));
    const exportRes = await send({ type: 'exportData', includeSecrets: true, passphrase: 'pw' });
    if (!exportRes.ok) throw new Error('unreachable');

    // a1's secret rotates locally after the export was taken; a1 is still the only imported account.
    await storage.updateState((s) => ({ ...s, secrets: [{ accountId: 'a1', sessionKey: 'a1-rotated-locally' }] }));

    const importRes = await send({ type: 'importData', payload: exportRes.data.payload, passphrase: 'pw' });
    expect(importRes.ok).toBe(true);

    const state = await storage.loadState();
    expect(state.secrets.find((s) => s.accountId === 'a1')?.sessionKey).toBe('a1-original'); // import wins for a1
  });

  it('drops secrets for accounts the import no longer includes', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [account('a1'), account('a2')],
      secrets: [
        { accountId: 'a1', sessionKey: 'a1-secret' },
        { accountId: 'a2', sessionKey: 'a2-secret' },
      ],
    }));
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.accounts = [account('a1')]; // a2 dropped from the imported account list

    await send({ type: 'importData', payload: JSON.stringify(payload) });

    const state = await storage.loadState();
    expect(state.secrets.map((s) => s.accountId)).toEqual(['a1']);
  });

  it('nulls out activeAccountId when the import drops that account', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1')], activeAccountId: 'a1' }));
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.accounts = [account('other')];

    await send({ type: 'importData', payload: JSON.stringify(payload) });

    const state = await storage.loadState();
    expect(state.activeAccountId).toBeNull();
  });

  it('nulls out activePlatformAccountId when the import drops that account', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('platform:u1')], activePlatformAccountId: 'platform:u1' }));
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.accounts = [];

    await send({ type: 'importData', payload: JSON.stringify(payload) });

    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBeNull();
  });

  it('keeps activeAccountId when the account survives the import', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1'), account('a2')], activeAccountId: 'a1' }));
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');

    await send({ type: 'importData', payload: exportRes.data.payload });

    const state = await storage.loadState();
    expect(state.activeAccountId).toBe('a1');
  });

  it('reschedules polling and updates the badge after a successful import', async () => {
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.settings = { pollIntervalMinutes: 42 };

    await send({ type: 'importData', payload: JSON.stringify(payload) });

    expect(scheduler.schedulePolling).toHaveBeenCalledWith(42);
    expect(scheduler.updateBadge).toHaveBeenCalled();
  });

  it('records the PBKDF2 iteration count used, so it can change later without breaking old exports', async () => {
    await storage.updateState((s) => ({ ...s, secrets: [{ accountId: 'a1', sessionKey: 'shh' }] }));
    const exportRes = await send({ type: 'exportData', includeSecrets: true, passphrase: 'pw' });
    if (!exportRes.ok) throw new Error('unreachable');
    const parsed = JSON.parse(exportRes.data.payload);
    expect(parsed.secrets.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it('imported settings.notifications deep-merge without wiping the other service', async () => {
    const exportRes = await send({ type: 'exportData', includeSecrets: false });
    if (!exportRes.ok) throw new Error('unreachable');
    const payload = JSON.parse(exportRes.data.payload);
    payload.settings = { notifications: { claude: { enabled: false } } };

    await send({ type: 'importData', payload: JSON.stringify(payload) });

    const state = await storage.loadState();
    expect(state.settings.notifications.claude.enabled).toBe(false);
    expect(state.settings.notifications.platform.enabled).toBe(true);
  });

  it('still imports a legacy export whose secrets blob has no recorded iteration count', async () => {
    const passphrase = 'legacy-pw';
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const plaintext = new TextEncoder().encode(JSON.stringify([{ accountId: 'legacy-acc', sessionKey: 'legacy-secret' }]));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

    const legacyPayload = {
      version: 1,
      exportedAt: Date.now(),
      accounts: [account('legacy-acc')], // must exist or the secret is pruned as orphaned (item 5)
      rules: [],
      settings: {},
      history: [],
      secrets: { salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) }, // no `iterations` field
    };

    const importRes = await send({ type: 'importData', payload: JSON.stringify(legacyPayload), passphrase });
    expect(importRes.ok).toBe(true);
    const state = await storage.loadState();
    expect(state.secrets.find((s) => s.accountId === 'legacy-acc')?.sessionKey).toBe('legacy-secret');
  });
});

describe('removeAccount cleanup', () => {
  it('removes the account id from settings.accountOrder', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('a1'), account('a2')], settings: { ...s.settings, accountOrder: ['a1', 'a2'] } }));
    await send({ type: 'removeAccount', accountId: 'a1' });
    const state = await storage.loadState();
    expect(state.settings.accountOrder).toEqual(['a2']);
  });

  it('disables rules whose specific target is the removed account and clears their lastRuleFire', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [account('a1'), account('a2')],
      rules: [{ id: 'r1', name: 'R1', enabled: true, condition: { type: 'limitReached' }, target: { type: 'specific', accountId: 'a1' }, cooldownMinutes: 5, confirm: false }],
      lastRuleFire: { r1: 123 },
    }));
    await send({ type: 'removeAccount', accountId: 'a1' });
    const state = await storage.loadState();
    expect(state.rules[0]!.enabled).toBe(false);
    expect(state.lastRuleFire.r1).toBeUndefined();
  });

  it('clears activePlatformAccountId when the removed account was the active platform one', async () => {
    await storage.updateState((s) => ({ ...s, accounts: [account('platform:u1')], activePlatformAccountId: 'platform:u1' }));
    await send({ type: 'removeAccount', accountId: 'platform:u1' });
    const state = await storage.loadState();
    expect(state.activePlatformAccountId).toBeNull();
  });

  it('leaves rules targeting a different account untouched', async () => {
    await storage.updateState((s) => ({
      ...s,
      accounts: [account('a1'), account('a2'), account('a3')],
      rules: [
        { id: 'r1', name: 'R1', enabled: true, condition: { type: 'limitReached' }, target: { type: 'specific', accountId: 'a2' }, cooldownMinutes: 5, confirm: false },
        { id: 'r2', name: 'R2', enabled: true, condition: { type: 'limitReached' }, target: { type: 'next' }, cooldownMinutes: 5, confirm: false },
      ],
      lastRuleFire: { r1: 1, r2: 2 },
    }));
    await send({ type: 'removeAccount', accountId: 'a3' });
    const state = await storage.loadState();
    expect(state.rules[0]!.enabled).toBe(true);
    expect(state.rules[1]!.enabled).toBe(true);
    expect(state.lastRuleFire).toEqual({ r1: 1, r2: 2 });
  });
});
