import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './chromeMock';
import { loadState, mergeSettings, pushHistory, updateState } from '../../src/background/storage';
import { DEFAULT_SETTINGS, DEFAULT_NOTIFICATIONS } from '../../src/shared/types';
import type { SwitchEvent } from '../../src/shared/types';

beforeEach(() => {
  installChromeMock();
});

describe('loadState', () => {
  it('returns default state when storage is empty', async () => {
    const state = await loadState();
    expect(state).toEqual({
      schemaVersion: 1,
      accounts: [],
      secrets: [],
      activeAccountId: null,
      activePlatformAccountId: null,
      rules: [],
      settings: DEFAULT_SETTINGS,
      history: [],
      lastRuleFire: {},
    });
  });

  it('fills in missing fields from a partial/older record (pre-platform-support data)', async () => {
    const { localData } = installChromeMock();
    localData.state = { accounts: [{ id: 'a1' }], settings: { pollIntervalMinutes: 15 } };
    const state = await loadState();
    expect(state.accounts).toEqual([{ id: 'a1' }]);
    expect(state.settings.pollIntervalMinutes).toBe(15);
    expect(state.settings.theme).toBe(DEFAULT_SETTINGS.theme); // merged default
    expect(state.secrets).toEqual([]);
    expect(state.lastRuleFire).toEqual({});
    expect(state.activePlatformAccountId).toBeNull();
  });

  it('preserves an existing activePlatformAccountId', async () => {
    const { localData } = installChromeMock();
    localData.state = { activePlatformAccountId: 'platform:u1' };
    const state = await loadState();
    expect(state.activePlatformAccountId).toBe('platform:u1');
  });

  it('caps a persisted history longer than 200 on load', async () => {
    const { localData } = installChromeMock();
    const long = Array.from({ length: 250 }, (_, i) => ({ at: i, fromAccountId: null, toAccountId: 'a', reason: 'manual' }));
    localData.state = { history: long };
    const state = await loadState();
    expect(state.history).toHaveLength(200);
  });

  it('persists the defaults immediately on a fresh install, rather than only in memory', async () => {
    const { localData } = installChromeMock();
    expect(localData.state).toBeUndefined();
    await loadState();
    expect(localData.state).toBeDefined();
    expect((localData.state as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it('does not rewrite storage on every load once a record already exists', async () => {
    const { localData, chromeMock } = installChromeMock();
    localData.state = { accounts: [{ id: 'a1' }] };
    await loadState();
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('updateState', () => {
  it('persists the mutated state and returns it', async () => {
    const result = await updateState((s) => ({ ...s, activeAccountId: 'a1' }));
    expect(result.activeAccountId).toBe('a1');
    const reloaded = await loadState();
    expect(reloaded.activeAccountId).toBe('a1');
  });

  it('caps history at 200 entries after an update', async () => {
    const event: SwitchEvent = { at: 1, fromAccountId: null, toAccountId: 'a1', reason: 'manual' };
    const result = await updateState((s) => ({ ...s, history: Array.from({ length: 205 }, () => event) }));
    expect(result.history).toHaveLength(200);
  });

  it('serializes concurrent updates so none are lost', async () => {
    const calls = Array.from({ length: 10 }, (_, i) => () => updateState((s) => ({ ...s, lastRuleFire: { ...s.lastRuleFire, [`r${i}`]: i } })));
    await Promise.all(calls.map((c) => c()));
    const final = await loadState();
    for (let i = 0; i < 10; i++) expect(final.lastRuleFire[`r${i}`]).toBe(i);
  });

  it('continues serializing even after one update throws', async () => {
    await expect(
      updateState(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const result = await updateState((s) => ({ ...s, activeAccountId: 'after-error' }));
    expect(result.activeAccountId).toBe('after-error');
  });
});

describe('pushHistory', () => {
  it('prepends the event and caps at 200', async () => {
    const base = await loadState();
    const existing = Array.from({ length: 200 }, (_, i) => ({ at: i, fromAccountId: null, toAccountId: 'a', reason: 'manual' as const }));
    const event: SwitchEvent = { at: 999, fromAccountId: 'a1', toAccountId: 'a2', reason: 'manual' };
    const next = pushHistory({ ...base, history: existing }, event);
    expect(next.history).toHaveLength(200);
    expect(next.history[0]).toEqual(event);
  });
});

describe('notifications settings migration', () => {
  it('seeds notifications.claude.usageThresholds from the deprecated notifyAtPercent on load', async () => {
    const { localData } = installChromeMock();
    localData.state = { settings: { notifyAtPercent: [50, 90] } };
    const state = await loadState();
    expect(state.settings.notifications.claude.usageThresholds).toEqual([50, 90]);
    expect(state.settings.notifications.platform).toEqual(DEFAULT_NOTIFICATIONS.platform);
  });

  it('defaults notifications fully when neither notifications nor notifyAtPercent is present', async () => {
    const { localData } = installChromeMock();
    localData.state = { accounts: [] };
    const state = await loadState();
    expect(state.settings.notifications).toEqual(DEFAULT_NOTIFICATIONS);
  });

  it('a stored partial notifications object does not wipe out the other service defaults', async () => {
    const { localData } = installChromeMock();
    localData.state = { settings: { notifications: { claude: { enabled: false } } } };
    const state = await loadState();
    expect(state.settings.notifications.claude.enabled).toBe(false);
    expect(state.settings.notifications.claude.usageThresholds).toEqual(DEFAULT_NOTIFICATIONS.claude.usageThresholds);
    expect(state.settings.notifications.platform).toEqual(DEFAULT_NOTIFICATIONS.platform);
  });

  it('an explicit stored notifications object takes precedence over a legacy notifyAtPercent', async () => {
    const { localData } = installChromeMock();
    localData.state = { settings: { notifyAtPercent: [10], notifications: { claude: { usageThresholds: [77] } } } };
    const state = await loadState();
    expect(state.settings.notifications.claude.usageThresholds).toEqual([77]);
  });
});

describe('mergeSettings', () => {
  it('deep-merges a partial notifications patch without wiping the other service', () => {
    const base = DEFAULT_SETTINGS;
    const next = mergeSettings(base, { notifications: { claude: { enabled: false } } } as never);
    expect(next.notifications.claude.enabled).toBe(false);
    expect(next.notifications.claude.usageThresholds).toEqual(DEFAULT_NOTIFICATIONS.claude.usageThresholds);
    expect(next.notifications.platform).toEqual(DEFAULT_NOTIFICATIONS.platform);
  });

  it('applies non-notifications fields directly', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { pollIntervalMinutes: 15 });
    expect(next.pollIntervalMinutes).toBe(15);
  });
});
