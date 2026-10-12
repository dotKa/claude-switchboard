// chrome.runtime.onMessage handler: one case per Request in src/shared/messages.ts, replying with
// the Response<T> envelope and broadcasting a stateChanged event after every successful request.
import type { PublicState, Request, Response, ResponseMap } from '../shared/messages';
import type { Account, AccountSecret, StorageSchema } from '../shared/types';
import { hasPlatformPermission } from './permissions';
import { addAccountFlow, captureCurrentAccount, isSessionUnsaved, switchAccount } from './session';
import { refreshUsage, schedulePolling, switchToNext, updateBadge } from './scheduler';
import { loadState, mergeSettings, updateState } from './storage';

// Each service's piece of state is isolated in its own try/catch — an unexpected failure reading
// one service (e.g. the platform permission check itself throwing) must never crash the whole
// getState response and break the popup for claude.ai too.
async function toPublicState(state: StorageSchema): Promise<PublicState> {
  const [unsavedSessionDetected, unsavedPlatformSessionDetected, platformPermission] = await Promise.all([
    isSessionUnsaved('claude', state).catch(() => false),
    isSessionUnsaved('platform', state).catch(() => false),
    hasPlatformPermission().catch(() => false),
  ]);
  return {
    accounts: state.accounts,
    activeAccountId: state.activeAccountId,
    activePlatformAccountId: state.activePlatformAccountId,
    rules: state.rules,
    settings: state.settings,
    history: state.history,
    unsavedSessionDetected,
    unsavedPlatformSessionDetected,
    platformPermission,
  };
}

// ---- export/import, with WebCrypto AES-GCM (PBKDF2-derived key) for secrets --------------------

interface EncryptedSecretsBlob {
  salt: string;
  iv: string;
  ciphertext: string;
  /** Omitted on exports made before this field existed — those used `LEGACY_PBKDF2_ITERATIONS`. */
  iterations?: number;
}

const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 100_000;

interface ExportPayloadV1 {
  version: 1;
  exportedAt: number;
  accounts: StorageSchema['accounts'];
  rules: StorageSchema['rules'];
  settings: StorageSchema['settings'];
  history: StorageSchema['history'];
  secrets?: EncryptedSecretsBlob;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptSecrets(secrets: AccountSecret[], passphrase: string): Promise<EncryptedSecretsBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext);
  return { salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)), iterations: PBKDF2_ITERATIONS };
}

async function decryptSecrets(blob: EncryptedSecretsBlob, passphrase: string): Promise<AccountSecret[]> {
  const key = await deriveKey(passphrase, fromBase64(blob.salt), blob.iterations ?? LEGACY_PBKDF2_ITERATIONS);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) as BufferSource }, key, fromBase64(blob.ciphertext) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plaintext)) as AccountSecret[];
  } catch {
    throw new Error('Could not decrypt secrets — wrong passphrase or corrupted data.');
  }
}

async function exportData(includeSecrets: boolean, passphrase?: string): Promise<string> {
  if (includeSecrets && !passphrase) throw new Error('A passphrase is required to export secrets.');
  const state = await loadState();
  const payload: ExportPayloadV1 = {
    version: 1,
    exportedAt: Date.now(),
    accounts: state.accounts,
    rules: state.rules,
    settings: state.settings,
    history: state.history,
  };
  if (includeSecrets && passphrase) payload.secrets = await encryptSecrets(state.secrets, passphrase);
  return JSON.stringify(payload);
}

/** Parses and validates the payload shape only — never touches storage, so a bad export never
 * leaves a partial write behind. */
function parseExportPayload(payloadJson: string): Partial<ExportPayloadV1> {
  const parsed = JSON.parse(payloadJson) as Partial<ExportPayloadV1>;
  if (parsed.version !== 1) throw new Error('Unrecognized export format.');
  if (parsed.accounts !== undefined && !Array.isArray(parsed.accounts)) throw new Error('Invalid export: "accounts" must be a list.');
  if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) throw new Error('Invalid export: "rules" must be a list.');
  if (parsed.history !== undefined && !Array.isArray(parsed.history)) throw new Error('Invalid export: "history" must be a list.');
  return parsed;
}

async function importData(payloadJson: string, passphrase?: string): Promise<StorageSchema> {
  const parsed = parseExportPayload(payloadJson);

  // Decrypt BEFORE mutating anything, so a wrong passphrase (or any other failure) leaves storage
  // completely untouched instead of a half-applied import.
  let importedSecrets: AccountSecret[] | null = null;
  if (parsed.secrets) {
    if (!passphrase) throw new Error('This export includes encrypted secrets — a passphrase is required to import them.');
    importedSecrets = await decryptSecrets(parsed.secrets, passphrase);
  }

  return updateState((s) => {
    const mergedSecrets = importedSecrets
      ? [...s.secrets.filter((sec) => !importedSecrets!.some((imported) => imported.accountId === sec.accountId)), ...importedSecrets]
      : s.secrets;
    const accounts = parsed.accounts ?? s.accounts;
    // Prune any secret left pointing at an account that doesn't exist after this import — e.g. the
    // import replaced the account list with one that drops it — so it can't linger as an orphan.
    const accountIds = new Set(accounts.map((a) => a.id));
    const secrets = mergedSecrets.filter((sec) => accountIds.has(sec.accountId));
    return {
      ...s,
      accounts,
      rules: parsed.rules ?? s.rules,
      settings: mergeSettings(s.settings, parsed.settings),
      history: parsed.history ?? s.history,
      secrets,
      activeAccountId: s.activeAccountId !== null && !accountIds.has(s.activeAccountId) ? null : s.activeAccountId,
      activePlatformAccountId: s.activePlatformAccountId !== null && !accountIds.has(s.activePlatformAccountId) ? null : s.activePlatformAccountId,
    };
  });
}

/** Whitelists `updateAccount`'s patch to label/color/paused at runtime — messages.ts's type says
 * the same thing, but a message arrives as plain JSON with no compile-time guarantee behind it. */
function sanitizeAccountPatch(patch: unknown): Partial<Pick<Account, 'label' | 'color' | 'paused'>> {
  if (typeof patch !== 'object' || patch === null) return {};
  const p = patch as Record<string, unknown>;
  const out: Partial<Pick<Account, 'label' | 'color' | 'paused'>> = {};
  if (typeof p.label === 'string') out.label = p.label;
  if (typeof p.color === 'string') out.color = p.color;
  if (typeof p.paused === 'boolean') out.paused = p.paused;
  return out;
}

// ---- request dispatch ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'getState':
      return toPublicState(await loadState());

    case 'captureCurrentAccount': {
      const account = await captureCurrentAccount(req.service ?? 'claude');
      await updateBadge();
      return account;
    }

    case 'switchAccount':
      await switchAccount(req.accountId, 'manual');
      await updateBadge();
      return toPublicState(await loadState());

    case 'switchNext':
      await switchToNext(req.service ?? 'claude');
      return toPublicState(await loadState());

    case 'removeAccount':
      await updateState((s) => {
        const affectedRuleIds = new Set(s.rules.filter((r) => r.target.type === 'specific' && r.target.accountId === req.accountId).map((r) => r.id));
        return {
          ...s,
          accounts: s.accounts.filter((a) => a.id !== req.accountId),
          secrets: s.secrets.filter((sec) => sec.accountId !== req.accountId),
          activeAccountId: s.activeAccountId === req.accountId ? null : s.activeAccountId,
          activePlatformAccountId: s.activePlatformAccountId === req.accountId ? null : s.activePlatformAccountId,
          settings: { ...s.settings, accountOrder: s.settings.accountOrder.filter((id) => id !== req.accountId) },
          rules: s.rules.map((r) => (affectedRuleIds.has(r.id) ? { ...r, enabled: false } : r)),
          lastRuleFire: Object.fromEntries(Object.entries(s.lastRuleFire).filter(([ruleId]) => !affectedRuleIds.has(ruleId))),
        };
      });
      return toPublicState(await loadState());

    case 'updateAccount':
      await updateState((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === req.accountId ? { ...a, ...sanitizeAccountPatch(req.patch) } : a)) }));
      return toPublicState(await loadState());

    case 'refreshUsage':
      await refreshUsage(req.accountId);
      await updateBadge();
      return toPublicState(await loadState());

    case 'addAccountFlow':
      await addAccountFlow(req.service ?? 'claude');
      return { ok: true } as const;

    case 'saveRules':
      await updateState((s) => ({ ...s, rules: req.rules }));
      return toPublicState(await loadState());

    case 'saveSettings': {
      const next = await updateState((s) => ({ ...s, settings: mergeSettings(s.settings, req.settings) }));
      await schedulePolling(next.settings.pollIntervalMinutes);
      await updateBadge();
      return toPublicState(next);
    }

    case 'exportData':
      return { payload: await exportData(req.includeSecrets, req.passphrase) };

    case 'importData': {
      const next = await importData(req.payload, req.passphrase);
      await schedulePolling(next.settings.pollIntervalMinutes);
      await updateBadge();
      return toPublicState(next);
    }

    default: {
      const unknownType = (req as unknown as { type?: unknown }).type;
      throw new Error(`Unknown request type: ${String(unknownType)}`);
    }
  }
}

export async function broadcastState(): Promise<void> {
  const state = await toPublicState(await loadState());
  try {
    await chrome.runtime.sendMessage({ type: 'stateChanged', state });
  } catch {
    // No popup/options page listening — fine to ignore.
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const req = message as Request;
  // This extension's own pages/content scripts only — a defensive check against another extension
  // somehow reaching this listener (chrome.runtime.onMessage normally only fires for the same
  // extension anyway, but nothing stops a future manifest change from widening that).
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Unauthorized sender.' } satisfies Response<typeof req.type>);
    return true;
  }
  handleRequest(req)
    .then((data) => {
      sendResponse({ ok: true, data } as Response<typeof req.type>);
      if (req.type !== 'getState') void broadcastState();
    })
    .catch((err: unknown) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response<typeof req.type>);
    });
  return true; // keep the message channel open for the async response
});

export type { ExportPayloadV1 };
export { toPublicState };

