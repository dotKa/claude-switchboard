// Typed wrapper around chrome.storage.local for StorageSchema. The whole schema lives under a
// single key so a read-modify-write cycle is a single get + a single set. Secrets live in this same
// object (in chrome.storage.local), never in chrome.storage.sync and never copied into PublicState.
import type { Settings, StorageSchema, SwitchEvent } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

const STORAGE_KEY = 'state';
export const HISTORY_LIMIT = 200;

/**
 * Merges a `Settings` patch onto a base, deep-merging `notifications` per service so a partial
 * patch (e.g. just `{ notifications: { claude: { enabled: false } } }`) can't wipe out the other
 * service's settings via a shallow `{...base, ...patch}`. Also migrates the deprecated
 * `notifyAtPercent` into `notifications.claude.usageThresholds` when present and no explicit
 * `notifications.claude.usageThresholds` overrides it.
 */
export function mergeSettings(base: Settings, patch: Partial<Settings> = {}): Settings {
  const legacyThresholds = Array.isArray(patch.notifyAtPercent) ? patch.notifyAtPercent : undefined;
  return {
    ...base,
    ...patch,
    notifications: {
      claude: { ...base.notifications.claude, ...(legacyThresholds ? { usageThresholds: legacyThresholds } : {}), ...patch.notifications?.claude },
      platform: { ...base.notifications.platform, ...patch.notifications?.platform },
    },
  };
}

function defaultState(): StorageSchema {
  return {
    schemaVersion: 1,
    accounts: [],
    secrets: [],
    activeAccountId: null,
    activePlatformAccountId: null,
    rules: [],
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    lastRuleFire: {},
  };
}

/** Fills in defaults for anything missing/malformed. Schema version 1 is the only one today — this
 * is where a future `schemaVersion` bump would branch into real field migrations. */
function migrate(stored: unknown): StorageSchema {
  const fallback = defaultState();
  if (typeof stored !== 'object' || stored === null) return fallback;
  const s = stored as Partial<StorageSchema>;
  return {
    schemaVersion: 1,
    accounts: Array.isArray(s.accounts) ? s.accounts : fallback.accounts,
    secrets: Array.isArray(s.secrets) ? s.secrets : fallback.secrets,
    activeAccountId: s.activeAccountId ?? null,
    activePlatformAccountId: s.activePlatformAccountId ?? null,
    rules: Array.isArray(s.rules) ? s.rules : fallback.rules,
    settings: mergeSettings(DEFAULT_SETTINGS, s.settings as Partial<Settings> | undefined),
    history: Array.isArray(s.history) ? s.history.slice(0, HISTORY_LIMIT) : fallback.history,
    lastRuleFire: typeof s.lastRuleFire === 'object' && s.lastRuleFire !== null ? s.lastRuleFire : fallback.lastRuleFire,
  };
}

export async function loadState(): Promise<StorageSchema> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (result as Record<string, unknown>)[STORAGE_KEY];
  const state = migrate(raw);
  if (raw === undefined) await saveState(state); // fresh install — persist the defaults right away
  return state;
}

async function saveState(state: StorageSchema): Promise<void> {
  const capped: StorageSchema = { ...state, history: state.history.slice(0, HISTORY_LIMIT) };
  await chrome.storage.local.set({ [STORAGE_KEY]: capped });
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Serializes read-modify-write cycles through a promise queue so concurrent callers (e.g. a poll
 * tick and a popup message arriving at the same time) never clobber each other's writes.
 */
export function updateState(mutator: (state: StorageSchema) => StorageSchema | Promise<StorageSchema>): Promise<StorageSchema> {
  const result = tail.then(async () => {
    const current = await loadState();
    const mutated = await mutator(current);
    const next: StorageSchema = { ...mutated, history: mutated.history.slice(0, HISTORY_LIMIT) };
    await saveState(next);
    return next;
  });
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function pushHistory(state: StorageSchema, event: SwitchEvent): StorageSchema {
  return { ...state, history: [event, ...state.history].slice(0, HISTORY_LIMIT) };
}
