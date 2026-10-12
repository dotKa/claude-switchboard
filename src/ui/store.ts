// Unidirectional state glue for popup/options.
// Talks to the background ONLY via send(); renders from PublicState + `stateChanged` broadcasts.
// Falls back to an in-memory mock when running outside the extension (vite dev server).
import type { PublicState, StateChangedEvent } from '../shared/messages';
import { send } from '../shared/messages';
import type { Request, ResponseMap } from '../shared/messages';
import { createMockState } from './mock';

type Listener = () => void;

let state: PublicState | null = null;
const listeners = new Set<Listener>();

function isExtensionRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

export const mockMode = !isExtensionRuntime();

let mockStateRef: PublicState | null = null;
if (mockMode) {
  mockStateRef = createMockState();
}

/** Persisted view of the world. Throws if used before `initStore()` resolves. */
export function getState(): PublicState {
  if (!state) throw new Error('store used before initStore()');
  return state;
}

export function onStateChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

function setState(next: PublicState): void {
  state = next;
  notify();
}

export async function initStore(): Promise<PublicState> {
  if (!mockMode) {
    state = await send({ type: 'getState' });
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      const evt = msg as StateChangedEvent | undefined;
      if (evt && evt.type === 'stateChanged' && evt.state) setState(evt.state);
    });
  } else {
    state = mockStateRef as PublicState;
  }
  return state;
}

/** Re-read state from the background (e.g. after a permission change made in this page). */
export async function reloadState(): Promise<void> {
  if (mockMode) return;
  setState(await send({ type: 'getState' }));
}

/**
 * Send a request to the background (or apply it to the mock when running detached).
 * Background-initiated broadcast responses carry the new state; we adopt them eagerly.
 */
export async function call<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
  if (!mockMode) {
    const data = await send(req);
    if (data && typeof data === 'object' && 'accounts' in data && 'settings' in data) {
      setState(data as PublicState);
    }
    return data;
  }
  const { data, state: next } = applyMock(req, mockStateRef as PublicState);
  mockStateRef = next;
  if (next !== null) setState(next);
  return data as ResponseMap[R['type']];
}

function applyMock(req: Request, s: PublicState): { data: unknown; state: PublicState | null } {
  switch (req.type) {
    case 'getState':
      return { data: s, state: s };
    case 'captureCurrentAccount':
    case 'switchNext':
    case 'addAccountFlow':
      // Mock: pretend it succeeded; leave state untouched.
      return { data: req.type === 'addAccountFlow' ? { ok: true } : s, state: s };
    case 'switchAccount':
      return { data: s, state: { ...s, activeAccountId: req.accountId } };
    case 'removeAccount':
      return {
        data: s,
        state: {
          ...s,
          accounts: s.accounts.filter((a) => a.id !== req.accountId),
          settings: { ...s.settings, accountOrder: s.settings.accountOrder.filter((id) => id !== req.accountId) },
          activeAccountId: s.activeAccountId === req.accountId ? null : s.activeAccountId,
        },
      };
    case 'updateAccount':
      return {
        data: s,
        state: {
          ...s,
          accounts: s.accounts.map((a) => (a.id === req.accountId ? { ...a, ...req.patch } : a)),
        },
      };
    case 'refreshUsage':
      return { data: s, state: null };
    case 'saveRules':
      return { data: s, state: { ...s, rules: req.rules } };
    case 'saveSettings':
      return { data: s, state: { ...s, settings: { ...s.settings, ...req.settings } } };
    case 'exportData':
      return {
        data: {
          payload: JSON.stringify({
            note: 'Switchboard for Claude export (mock)',
            includeSecrets: req.includeSecrets,
            exportedAt: new Date().toISOString(),
            data: {
              accounts: s.accounts,
              activeAccountId: s.activeAccountId,
              rules: s.rules,
              settings: s.settings,
              history: s.history,
              secrets: req.includeSecrets ? [{ accountId: 'acct-anna', sessionKey: '***redacted-mock***' }] : undefined,
            },
          }),
        },
        state: null,
      };
    case 'importData':
      return { data: s, state: null };
  }
}
