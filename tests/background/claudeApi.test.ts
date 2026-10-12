import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import {
  buildPlatformBilling,
  buildPlatformUsageSnapshot,
  clearLeftoverUsageOverrideRules,
  derivePlanTier,
  DnrUnavailableError,
  fetchAccountInfo,
  fetchOrganizations,
  fetchPlatformUsage,
  fetchUsage,
  fetchUsageWithSessionOverride,
  parseAccountInfo,
  parseCurrentSpend,
  parseOrganizations,
  parseUsageSnapshot,
  SessionExpiredError,
} from '../../src/background/claudeApi';

describe('parseAccountInfo', () => {
  it('extracts id, email and display name', () => {
    const info = parseAccountInfo({ uuid: 'u1', email_address: 'me@example.com', full_name: 'Me' });
    expect(info).toEqual({ id: 'u1', email: 'me@example.com', displayName: 'Me' });
  });

  it('falls back to email when full_name is missing', () => {
    const info = parseAccountInfo({ uuid: 'u1', email_address: 'me@example.com' });
    expect(info.displayName).toBe('me@example.com');
  });

  it('tolerates missing email', () => {
    const info = parseAccountInfo({ uuid: 'u1' });
    expect(info).toEqual({ id: 'u1', email: '', displayName: '' });
  });
});

describe('derivePlanTier', () => {
  it('maps a raven team org', () => {
    expect(derivePlanTier(['raven', 'chat'], 'team')).toBe('team');
  });

  it('maps a raven enterprise org', () => {
    expect(derivePlanTier(['raven', 'chat'], 'enterprise')).toBe('enterprise');
  });

  it('defaults raven without a type to team', () => {
    expect(derivePlanTier(['raven'], null)).toBe('team');
  });

  it('maps claude_max', () => {
    expect(derivePlanTier(['claude_max', 'chat'], null)).toBe('max');
  });

  it('maps claude_pro', () => {
    expect(derivePlanTier(['claude_pro', 'chat'], null)).toBe('pro');
  });

  it('falls back to free when only chat is present', () => {
    expect(derivePlanTier(['chat'], null)).toBe('free');
  });

  it('falls back to unknown for an empty or unrecognized capability list', () => {
    expect(derivePlanTier([], null)).toBe('unknown');
    expect(derivePlanTier(['something_else'], null)).toBe('unknown');
  });
});

describe('parseOrganizations', () => {
  it('parses a well-formed list, including capabilities and api_disabled_reason', () => {
    const orgs = parseOrganizations([{ uuid: 'o1', name: 'Acme', capabilities: ['claude_pro', 'chat'], api_disabled_reason: null }]);
    expect(orgs).toEqual([{ id: 'o1', name: 'Acme', plan: 'pro', capabilities: ['claude_pro', 'chat'], apiDisabledReason: null }]);
  });

  it('surfaces a non-null api_disabled_reason', () => {
    const orgs = parseOrganizations([{ uuid: 'o1', name: 'Acme', capabilities: ['api'], api_disabled_reason: 'out_of_credits' }]);
    expect(orgs[0]!.apiDisabledReason).toBe('out_of_credits');
  });

  it('returns an empty list for a non-array payload', () => {
    expect(parseOrganizations(null)).toEqual([]);
    expect(parseOrganizations({})).toEqual([]);
  });

  it('skips entries without a uuid', () => {
    expect(parseOrganizations([{ name: 'No id' }])).toEqual([]);
  });

  it('tolerates a missing capabilities list', () => {
    const orgs = parseOrganizations([{ uuid: 'o1', name: 'Acme' }]);
    expect(orgs[0]!.capabilities).toEqual([]);
    expect(orgs[0]!.apiDisabledReason).toBeNull();
  });
});

describe('parseUsageSnapshot', () => {
  it('parses legacy windows', () => {
    const snap = parseUsageSnapshot(
      {
        five_hour: { utilization: 42, resets_at: '2026-01-01T00:00:00Z' },
        seven_day: null,
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 10, resets_at: null },
      },
      1000,
    );
    expect(snap.fetchedAt).toBe(1000);
    expect(snap.fiveHour).toEqual({ utilization: 42, resetsAt: '2026-01-01T00:00:00Z' });
    expect(snap.sevenDay).toBeNull();
    expect(snap.sevenDayOpus).toBeNull();
    expect(snap.sevenDaySonnet).toEqual({ utilization: 10, resetsAt: null });
  });

  it('normalizes an array-shaped limits list', () => {
    const snap = parseUsageSnapshot(
      {
        limits: [
          { kind: 'session', group: 'session', percent: 22, severity: 'normal', resets_at: null, scope: null, is_active: true },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 0,
            severity: 'normal',
            resets_at: null,
            scope: { model: { display_name: 'Fable' } },
            is_active: false,
          },
        ],
      },
      0,
    );
    expect(snap.limits).toEqual([
      { kind: 'session', group: 'session', percent: 22, severity: 'normal', resetsAt: null, scopeLabel: null, isActive: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resetsAt: null, scopeLabel: 'Fable', isActive: false },
    ]);
  });

  it('normalizes an object-keyed limits payload ("0","1",…)', () => {
    const snap = parseUsageSnapshot(
      {
        limits: {
          '0': { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: null, scope: null, is_active: true },
          '1': { kind: 'weekly', group: 'weekly', percent: 10, severity: 'normal', resets_at: null, scope: null, is_active: true },
        },
      },
      0,
    );
    expect(snap.limits.map((l) => l.kind)).toEqual(['session', 'weekly']);
  });

  it('parses extra_usage when present', () => {
    const snap = parseUsageSnapshot({ extra_usage: { is_enabled: true, utilization: 12, spend_limit_reached: false } }, 0);
    expect(snap.extraUsage).toEqual({ enabled: true, utilization: 12, spendLimitReached: false });
  });

  it('leaves extraUsage null when absent', () => {
    expect(parseUsageSnapshot({}, 0).extraUsage).toBeNull();
  });

  it('tolerates a completely empty payload', () => {
    const snap = parseUsageSnapshot({}, 5);
    expect(snap).toEqual({
      fetchedAt: 5,
      limits: [],
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      extraUsage: null,
      raw: {},
    });
  });
});

describe('fetch wrappers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchAccountInfo returns parsed data on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ uuid: 'u1', email_address: 'a@b.com' }) }),
    );
    const info = await fetchAccountInfo();
    expect(info.id).toBe('u1');
  });

  it('fetchOrganizations throws SessionExpiredError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    await expect(fetchOrganizations()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('fetchUsage throws SessionExpiredError on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) }));
    await expect(fetchUsage('org1')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('fetchUsage requests the right URL with credentials included', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    await fetchUsage('org1');
    expect(fetchMock).toHaveBeenCalledWith('https://claude.ai/api/organizations/org1/usage', expect.objectContaining({ credentials: 'include' }));
  });

  it('fetchUsage throws a plain error on other non-ok statuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    await expect(fetchUsage('org1')).rejects.toThrow();
    await expect(fetchUsage('org1')).rejects.not.toBeInstanceOf(SessionExpiredError);
  });
});

describe('fetchUsageWithSessionOverride', () => {
  let mocks: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mocks = installChromeMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installs a session DNR rule scoped to the extension before fetching, without browsing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    await fetchUsageWithSessionOverride('org1', 'the-session-key');

    expect(mocks.chromeMock.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith(
      expect.objectContaining({
        addRules: [
          expect.objectContaining({
            condition: expect.objectContaining({ initiatorDomains: ['test-extension-id'], tabIds: [-1] }),
            action: expect.objectContaining({
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'Cookie', operation: 'set', value: 'sessionKey=the-session-key' }],
            }),
          }),
        ],
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: 'omit' }));
  });

  it('removes the session rule afterwards, even when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));

    await expect(fetchUsageWithSessionOverride('org1', 'key')).rejects.toThrow();

    const calls = mocks.chromeMock.declarativeNetRequest.updateSessionRules.mock.calls;
    const lastCall = calls.at(-1)?.[0];
    expect(lastCall).toEqual(expect.objectContaining({ removeRuleIds: expect.arrayContaining([expect.any(Number)]) }));
    expect(lastCall?.addRules).toBeUndefined();
  });

  it('propagates SessionExpiredError for the overridden session too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    await expect(fetchUsageWithSessionOverride('org1', 'key')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('uses a distinct rule id per call and removes only that id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }));

    await fetchUsageWithSessionOverride('org1', 'key-a');
    await fetchUsageWithSessionOverride('org1', 'key-b');

    const calls = mocks.chromeMock.declarativeNetRequest.updateSessionRules.mock.calls;
    const addCalls = calls.filter((c) => c[0].addRules);
    const firstId = addCalls[0]![0].addRules[0].id;
    const secondId = addCalls[1]![0].addRules[0].id;
    expect(firstId).not.toBe(secondId);

    const removeCalls = calls.filter((c) => c[0].removeRuleIds && !c[0].addRules);
    expect(removeCalls.map((c) => c[0].removeRuleIds)).toEqual([[firstId], [secondId]]);
  });

  it('throws DnrUnavailableError and never fetches when installing the session rule fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mocks.chromeMock.declarativeNetRequest.updateSessionRules.mockRejectedValueOnce(new Error('declarativeNetRequest disabled'));

    await expect(fetchUsageWithSessionOverride('org1', 'key')).rejects.toBeInstanceOf(DnrUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes overlapping override fetches so one rule is fully removed before the next is installed', async () => {
    const order: string[] = [];
    const pendingFetchResolvers: Array<() => void> = [];
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingFetchResolvers.push(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    mocks.chromeMock.declarativeNetRequest.updateSessionRules.mockImplementation((arg: { addRules?: unknown[]; removeRuleIds?: number[] }) => {
      order.push(arg.addRules ? 'add' : `remove:${arg.removeRuleIds?.[0]}`);
      return Promise.resolve();
    });

    const first = fetchUsageWithSessionOverride('org1', 'key-a');
    const second = fetchUsageWithSessionOverride('org2', 'key-b');
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain microtasks: first call reaches its fetch() and suspends
    expect(order).toEqual(['add']); // the second call must not have installed its rule yet
    expect(pendingFetchResolvers).toHaveLength(1); // and must not have called fetch() yet either

    pendingFetchResolvers[0]!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the second call now proceed to its own fetch()
    expect(pendingFetchResolvers).toHaveLength(2);

    pendingFetchResolvers[1]!();
    await second;

    expect(order[0]).toBe('add');
    expect(order[1]).toMatch(/^remove:/);
    expect(order[2]).toBe('add');
    expect(order[3]).toMatch(/^remove:/);
  });

  it('serializes the plain active-account fetch against a pending override fetch', async () => {
    const order: string[] = [];
    let resolveOverrideFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('org1')) {
        return new Promise((resolve) => {
          resolveOverrideFetch = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        });
      }
      order.push('active-fetch');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.chromeMock.declarativeNetRequest.updateSessionRules.mockImplementation(() => {
      order.push('dnr');
      return Promise.resolve();
    });

    const override = fetchUsageWithSessionOverride('org1', 'key-a');
    const active = fetchUsage('org2');
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain microtasks: override reaches its fetch() and suspends
    expect(order).toEqual(['dnr']); // the active fetch must wait until the override is fully done

    resolveOverrideFetch({});
    await override;
    await active;

    expect(order).toEqual(['dnr', 'dnr', 'active-fetch']);
  });
});

describe('clearLeftoverUsageOverrideRules', () => {
  let mocks: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mocks = installChromeMock();
  });

  it('removes only session rules within the override id range', async () => {
    mocks.chromeMock.declarativeNetRequest.getSessionRules = vi.fn().mockResolvedValue([{ id: 90042 }, { id: 1 }, { id: 99999 }]);

    await clearLeftoverUsageOverrideRules();

    expect(mocks.chromeMock.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [90042, 99999] });
  });

  it('does nothing when there are no leftover rules', async () => {
    mocks.chromeMock.declarativeNetRequest.getSessionRules = vi.fn().mockResolvedValue([{ id: 1 }]);

    await clearLeftoverUsageOverrideRules();

    expect(mocks.chromeMock.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled();
  });

  it('never throws, even if the chrome API fails', async () => {
    mocks.chromeMock.declarativeNetRequest.getSessionRules = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(clearLeftoverUsageOverrideRules()).resolves.toBeUndefined();
  });
});

describe('parseCurrentSpend', () => {
  it('extracts amount (cents) and resets_at', () => {
    expect(parseCurrentSpend({ amount: 1234, resets_at: '2026-02-01T00:00:00Z' })).toEqual({ amountCents: 1234, resetsAt: '2026-02-01T00:00:00Z' });
  });

  it('tolerates a missing/malformed payload', () => {
    expect(parseCurrentSpend({})).toEqual({ amountCents: null, resetsAt: null });
    expect(parseCurrentSpend(null)).toEqual({ amountCents: null, resetsAt: null });
  });
});

describe('buildPlatformBilling', () => {
  it('combines current_spend and api_disabled_reason', () => {
    const billing = buildPlatformBilling({ amount: 1000, resets_at: '2026-03-01T00:00:00Z' }, 'out_of_credits');
    expect(billing).toEqual({ spendCents: 1000, spendResetsAt: '2026-03-01T00:00:00Z', apiDisabledReason: 'out_of_credits' });
  });

  it('tolerates a missing current_spend payload', () => {
    expect(buildPlatformBilling(null, null)).toEqual({ spendCents: null, spendResetsAt: null, apiDisabledReason: null });
  });
});

describe('buildPlatformUsageSnapshot', () => {
  it('carries the billing object through unchanged with no synthetic limits and null legacy windows', () => {
    const billing = { spendCents: 2500, spendResetsAt: '2026-03-01T00:00:00Z', apiDisabledReason: null };
    const snap = buildPlatformUsageSnapshot(billing, 1000);
    expect(snap).toEqual({ fetchedAt: 1000, limits: [], fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, billing, extraUsage: null });
  });
});

describe('fetchPlatformUsage', () => {
  let mocks: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mocks = installChromeMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: () => Promise.resolve(body) };
  }

  it('fetches organizations + current_spend from the given origin and combines them', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/organizations')) return Promise.resolve(jsonResponse([{ uuid: 'org1', name: 'Acme', capabilities: ['api'], api_disabled_reason: 'out_of_credits' }]));
      if (url.endsWith('/current_spend')) return Promise.resolve(jsonResponse({ amount: 1000, resets_at: '2026-03-01T00:00:00Z' }));
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snap = await fetchPlatformUsage('org1', 'https://platform.claude.com');

    expect(fetchMock).toHaveBeenCalledWith('https://platform.claude.com/api/organizations', expect.objectContaining({ credentials: 'include' }));
    expect(fetchMock).toHaveBeenCalledWith('https://platform.claude.com/api/organizations/org1/current_spend', expect.anything());
    expect(snap.billing).toEqual({ spendCents: 1000, spendResetsAt: '2026-03-01T00:00:00Z', apiDisabledReason: 'out_of_credits' });
    expect(snap.limits).toEqual([]);
  });

  it('treats a non-auth current_spend failure as best-effort null, not a thrown error', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/organizations')) return Promise.resolve(jsonResponse([{ uuid: 'org1', name: 'Acme', capabilities: ['api'], api_disabled_reason: null }]));
      if (url.endsWith('/current_spend')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snap = await fetchPlatformUsage('org1', 'https://platform.claude.com');
    expect(snap.billing?.spendCents).toBeNull();
  });

  it('propagates SessionExpiredError from current_spend instead of swallowing it', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/organizations')) return Promise.resolve(jsonResponse([{ uuid: 'org1', name: 'Acme', capabilities: ['api'], api_disabled_reason: null }]));
      if (url.endsWith('/current_spend')) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPlatformUsage('org1', 'https://platform.claude.com')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('shares the serialization queue with the claude.ai usage fetches', async () => {
    const order: string[] = [];
    const pendingPlatformResolvers: Array<() => void> = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('platform.claude.com')) {
        return new Promise((resolve) => {
          pendingPlatformResolvers.push(() => resolve(jsonResponse(url.endsWith('/api/organizations') ? [] : {})));
        });
      }
      order.push('claude-fetch');
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const platform = fetchPlatformUsage('org1', 'https://platform.claude.com');
    const claude = fetchUsage('org2', 'https://claude.ai');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]); // the claude.ai fetch must wait until the platform one is fully done
    expect(pendingPlatformResolvers).toHaveLength(1); // organizations (sequential: current_spend comes after)

    pendingPlatformResolvers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingPlatformResolvers).toHaveLength(2); // now current_spend

    pendingPlatformResolvers[1]!();
    await platform;
    await claude;

    expect(order).toEqual(['claude-fetch']);
  });
});

describe('fetchUsageWithSessionOverride origin parameter', () => {
  let mocks: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mocks = installChromeMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scopes the DNR rule and the fetch to a given platform.claude.com origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    await fetchUsageWithSessionOverride('org1', 'the-key', 'https://platform.claude.com');

    expect(mocks.chromeMock.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith(
      expect.objectContaining({ addRules: [expect.objectContaining({ condition: expect.objectContaining({ urlFilter: expect.stringContaining('platform.claude.com') }) })] }),
    );
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('platform.claude.com'), expect.objectContaining({ credentials: 'omit' }));
  });
});
