// Popup/options <-> background RPC. Background implements a handler for every request type.
import type { Account, Service, SwitchRule, Settings, SwitchEvent } from './types';

/** Public, secret-free view of state for UI. */
export interface PublicState {
  accounts: Account[];
  activeAccountId: string | null;
  activePlatformAccountId: string | null;
  rules: SwitchRule[];
  settings: Settings;
  history: SwitchEvent[];
  /** True when a claude.ai session cookie exists that doesn't match any saved account. */
  unsavedSessionDetected: boolean;
  /** Same, for a platform.claude.com session. Always false without the platform permission. */
  unsavedPlatformSessionDetected: boolean;
  /** Whether the optional https://platform.claude.com/* host permission is granted. */
  platformPermission: boolean;
}

export type Request =
  | { type: 'getState' }
  | { type: 'captureCurrentAccount'; service?: Service } // save the currently logged-in session (default 'claude')
  | { type: 'switchAccount'; accountId: string }
  | { type: 'switchNext'; service?: Service } // default 'claude'
  | { type: 'removeAccount'; accountId: string }
  | { type: 'updateAccount'; accountId: string; patch: Partial<Pick<Account, 'label' | 'color' | 'paused'>> }
  | { type: 'refreshUsage'; accountId?: string } // omitted = all
  | { type: 'addAccountFlow'; service?: Service } // clears that service's session cookie and opens its login page
  | { type: 'saveRules'; rules: SwitchRule[] }
  | { type: 'saveSettings'; settings: Partial<Settings> }
  | { type: 'exportData'; includeSecrets: boolean; passphrase?: string }
  | { type: 'importData'; payload: string; passphrase?: string };

export type ResponseMap = {
  getState: PublicState;
  captureCurrentAccount: Account;
  switchAccount: PublicState;
  switchNext: PublicState;
  removeAccount: PublicState;
  updateAccount: PublicState;
  refreshUsage: PublicState;
  addAccountFlow: { ok: true };
  saveRules: PublicState;
  saveSettings: PublicState;
  exportData: { payload: string };
  importData: PublicState;
};

export type Response<T extends Request['type']> =
  | { ok: true; data: ResponseMap[T] }
  | { ok: false; error: string };

/** Broadcast from background whenever state changes: `{ type: 'stateChanged', state }`. */
export interface StateChangedEvent {
  type: 'stateChanged';
  state: PublicState;
}

export async function send<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<R['type']> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
