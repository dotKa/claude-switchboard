// Cookie-based session management, generalized over both services (claude.ai and
// platform.claude.com — see `SERVICES` in src/shared/types.ts). Each service has its own httpOnly
// `sessionKey` cookie on its own origin; swapping that cookie's value is what "switches accounts"
// from the browser's point of view, independently per service.
import type { Account, AccountSecret, Service, SwitchEvent } from '../shared/types';
import { SERVICES, serviceOf } from '../shared/types';
import { fetchAccountInfo, fetchOrganizations, fetchPlatformUsage, fetchUsage, type OrgInfo } from './claudeApi';
import { hasPlatformPermission } from './permissions';
import { loadState, pushHistory, updateState } from './storage';

const PLATFORM_PERMISSION_ERROR = 'Allow access to platform.claude.com first.';

/** Every platform-service operation below checks this before touching `chrome.cookies` — without
 * the optional host permission, those calls throw "No host permissions for cookies at url: ...". */
async function canUseService(service: Service): Promise<boolean> {
  return service !== 'platform' || hasPlatformPermission();
}

const SESSION_COOKIE_NAME = 'sessionKey';
// Unverified for claude.ai, verified live for platform (2026-10-12, on `.claude.com`): both
// services' web clients appear to remember the last active org client-side via a plain
// (non-httpOnly) `lastActiveOrg` cookie. Keeping it in sync with the account we just switched to
// avoids the UI showing a stale org. Best-effort only — every call is wrapped so a wrong guess
// about this cookie's existence/shape never breaks switching itself.
const LAST_ACTIVE_ORG_COOKIE = 'lastActiveOrg';
const PENDING_ADD_ACCOUNT_KEY_PREFIX = 'pendingAddAccount:';

function cookieOrigin(service: Service): string {
  return SERVICES[service].origin;
}

function isCookieDomainFor(service: Service, domain: string): boolean {
  const host = new URL(SERVICES[service].origin).host;
  if (domain === host || domain === `.${host}`) return true;
  // The platform `sessionKey` cookie's exact domain scoping is unverified — Anthropic might scope it
  // to the registrable domain `.claude.com` rather than the `platform.claude.com` subdomain (see
  // README "Known limitations"). Accept both here so auto-capture keeps working either way; this
  // function is only ever consulted for `sessionKey` changes (see the listener below), never for
  // `lastActiveOrg`, so widening it doesn't affect that cookie's handling.
  if (service === 'platform' && (domain === 'claude.com' || domain === '.claude.com')) return true;
  return false;
}

function serviceForCookieDomain(domain: string): Service | null {
  for (const service of Object.keys(SERVICES) as Service[]) {
    if (isCookieDomainFor(service, domain)) return service;
  }
  return null;
}

export function cookieToSecret(accountId: string, cookie: chrome.cookies.Cookie): AccountSecret {
  return { accountId, sessionKey: cookie.value, expirationDate: cookie.expirationDate };
}

export async function getCurrentSessionCookie(service: Service = 'claude'): Promise<chrome.cookies.Cookie | null> {
  if (!(await canUseService(service))) return null;
  const cookie = await chrome.cookies.get({ url: cookieOrigin(service), name: SESSION_COOKIE_NAME });
  return cookie ?? null;
}

async function setSessionCookie(secret: AccountSecret, template: chrome.cookies.Cookie | null, service: Service): Promise<void> {
  const details: chrome.cookies.SetDetails = {
    url: cookieOrigin(service),
    name: SESSION_COOKIE_NAME,
    value: secret.sessionKey,
    path: template?.path ?? '/',
    secure: template?.secure ?? true,
    httpOnly: template?.httpOnly ?? true,
    sameSite: template?.sameSite ?? 'lax',
    expirationDate: secret.expirationDate,
  };
  // A host-only cookie has no Domain attribute at all; passing `domain` here would force one,
  // widening the cookie's scope beyond what the service itself set. When there's no live cookie to
  // copy (`template` is null — e.g. right after addAccountFlow cleared it), default to host-only
  // too rather than guessing a domain, for the same reason.
  if (template && !template.hostOnly) details.domain = template.domain;
  await chrome.cookies.set(details);
}

async function removeSessionCookie(service: Service): Promise<void> {
  if (!(await canUseService(service))) return;
  await chrome.cookies.remove({ url: cookieOrigin(service), name: SESSION_COOKIE_NAME });
}

async function syncLastActiveOrgCookie(orgId: string, service: Service): Promise<void> {
  try {
    const url = cookieOrigin(service);
    const existing = await chrome.cookies.get({ url, name: LAST_ACTIVE_ORG_COOKIE });
    const details: chrome.cookies.SetDetails = {
      url,
      name: LAST_ACTIVE_ORG_COOKIE,
      value: orgId,
      path: existing?.path ?? '/',
      secure: existing?.secure ?? true,
      httpOnly: existing?.httpOnly ?? false,
      sameSite: existing?.sameSite ?? 'lax',
    };
    // Same host-only-by-default reasoning as setSessionCookie above: don't guess a domain when
    // there's no existing cookie to copy one from.
    if (existing && !existing.hostOnly) details.domain = existing.domain;
    await chrome.cookies.set(details);
  } catch {
    // Best-effort — see LAST_ACTIVE_ORG_COOKIE comment above.
  }
}

const SWITCHING_PAGE_PATH = 'switching/index.html';
// A parked-tab wait falls back to "done" after this long even if the tab never reports `complete`
// (e.g. it was closed, or Chrome is slow) — a switch must never hang indefinitely on one bad tab.
const PARK_TIMEOUT_MS = 4000;

// Platform support is account management only (see README "Two services") — there's no equivalent
// of a conversation/workspace URL to avoid landing a parked tab back on, so its landing page is
// simply the app root.
const LANDING_URL: Record<Service, string> = {
  claude: 'https://claude.ai/new',
  platform: 'https://platform.claude.com/',
};

function switchingPageUrl(): string {
  return chrome.runtime.getURL(SWITCHING_PAGE_PATH);
}

/** Resolves once `tabId` has finished loading the switching page itself — not merely `complete`,
 * which right after `tabs.update` can still describe the OLD page that is about to be replaced — or
 * after `PARK_TIMEOUT_MS`, whichever comes first. */
async function waitForTabParked(tabId: number): Promise<void> {
  const parkedUrl = switchingPageUrl();
  const isParked = (tab: chrome.tabs.Tab | undefined) =>
    tab?.status === 'complete' && (tab.url ?? '').startsWith(parkedUrl);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId: number, _changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId === tabId && isParked(tab)) finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, PARK_TIMEOUT_MS);
    // The tab may already be parked before the listener was attached; closed tabs just finish.
    chrome.tabs.get(tabId).then((tab) => isParked(tab) && finish(), finish);
  });
}

/**
 * Navigates every open tab on `service`'s origin to our own static "switching…" page and waits for
 * each to actually finish loading it, BEFORE any cookie is touched. This is the fix for the
 * repeated-logout bug: claude.ai's SPA reacts to an auth failure (its cached session no longer
 * matching the cookie we just swapped) by calling its own `/logout?involuntary=1`, which kills the
 * BRAND-NEW session server-side. Parking stops that SPA from running at all while the swap happens.
 */
async function parkServiceTabs(service: Service): Promise<number[]> {
  const tabs = await chrome.tabs.query({ url: `${SERVICES[service].origin}/*` });
  const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
  const url = switchingPageUrl();
  await Promise.all(ids.map((id) => chrome.tabs.update(id, { url }).catch(() => undefined)));
  await Promise.all(ids.map((id) => waitForTabParked(id)));
  return ids;
}

async function sendParkedTabsTo(tabIds: number[], url: string): Promise<void> {
  await Promise.all(tabIds.map((id) => chrome.tabs.update(id, { url }).catch(() => undefined)));
}

/** Clears the SPA's own cached-account state (`rq-cache-confirmed-account`, `__qk_hint_account_uuid`,
 * etc. — see README) for `service`'s origin, WITHOUT touching cookies, so a parked-and-restored tab
 * can't still believe it's logged in as the outgoing account. Best-effort: a failure here is
 * cosmetic (a stale cache the SPA will eventually refresh on its own), never worth blocking the
 * switch itself over. */
async function clearServiceSiteStorage(service: Service): Promise<void> {
  try {
    await chrome.browsingData.remove(
      { origins: [SERVICES[service].origin] },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
    );
  } catch {
    // See above — never let this block the switch.
  }
}

/**
 * Before overwriting the browser's live session cookie, confirm who it actually belongs to and
 * refresh THAT account's stored secret — never assume it's still the active account's. Sessions can
 * legitimately belong to a different saved account (the user logged in as someone else directly,
 * outside the extension) or to no saved account at all; in both of those cases this must do nothing
 * rather than guess, so `unsavedSessionDetected`/manual capture stays the source of truth.
 */
async function reconcileLiveSessionOwnership(cookie: chrome.cookies.Cookie, service: Service): Promise<void> {
  let info: { id: string };
  try {
    info = await fetchAccountInfo(SERVICES[service].origin);
  } catch {
    return; // can't verify ownership right now — never guess
  }
  if (!info.id) return;
  const accountId = service === 'platform' ? `platform:${info.id}` : info.id;
  await updateState((s) => {
    if (!s.accounts.some((a) => a.id === accountId)) return s; // unknown account — leave it alone
    return { ...s, secrets: s.secrets.map((sec) => (sec.accountId === accountId ? cookieToSecret(accountId, cookie) : sec)) };
  });
}

/**
 * Picks which org to track for a captured account. claude.ai: the org matching its `lastActiveOrg`
 * cookie if present, else the first non-free/non-unknown ("paid") org, else simply the first one.
 * platform: only orgs with the `api` capability are eligible at all (a `chat`-only org is the
 * claude.ai one); among those, prefer the `lastActiveOrg` match, else the first eligible one.
 */
async function pickOrganization(orgs: OrgInfo[], service: Service): Promise<OrgInfo | undefined> {
  const eligible = service === 'platform' ? orgs.filter((o) => o.capabilities.includes('api')) : orgs;
  if (eligible.length <= 1) return eligible[0];
  const lastActiveOrg = await chrome.cookies.get({ url: cookieOrigin(service), name: LAST_ACTIVE_ORG_COOKIE }).catch(() => null);
  const match = lastActiveOrg ? eligible.find((o) => o.id === lastActiveOrg.value) : undefined;
  if (match) return match;
  if (service === 'platform') return eligible[0];
  return eligible.find((o) => o.plan !== 'free' && o.plan !== 'unknown') ?? eligible[0];
}

function pendingAddAccountKey(service: Service): string {
  return `${PENDING_ADD_ACCOUNT_KEY_PREFIX}${service}`;
}

export async function setPendingAddAccount(service: Service, pending: boolean): Promise<void> {
  await chrome.storage.session.set({ [pendingAddAccountKey(service)]: pending });
}

export async function isPendingAddAccount(service: Service): Promise<boolean> {
  const key = pendingAddAccountKey(service);
  const result = await chrome.storage.session.get(key);
  return Boolean((result as Record<string, unknown>)[key]);
}

/** True when a `service` session cookie exists that doesn't match any saved account's secret. */
export async function isSessionUnsaved(service: Service, state: { secrets: AccountSecret[] }): Promise<boolean> {
  const cookie = await getCurrentSessionCookie(service);
  if (!cookie) return false;
  return !state.secrets.some((s) => s.sessionKey === cookie.value);
}

/** Saves (or refreshes) the currently logged-in session for `service` as a saved account. Platform
 * account ids are prefixed `platform:<uuid>` since the same person can have both a claude.ai and a
 * platform.claude.com account with the same underlying uuid. */
export async function captureCurrentAccount(service: Service = 'claude'): Promise<Account> {
  if (!(await canUseService(service))) throw new Error(PLATFORM_PERMISSION_ERROR);
  const cookie = await getCurrentSessionCookie(service);
  if (!cookie) throw new Error(`No ${SERVICES[service].label} session cookie found — log into ${SERVICES[service].label} first.`);

  const info = await fetchAccountInfo(SERVICES[service].origin);
  if (!info.id) throw new Error(`${SERVICES[service].label} did not return an account id — the session may be invalid.`);
  const orgs = await fetchOrganizations(SERVICES[service].origin);
  const org = await pickOrganization(orgs, service);
  if (!org) throw new Error(service === 'platform' ? 'This account has no organization with API access.' : 'This claude.ai account has no organization.');

  const accountId = service === 'platform' ? `platform:${info.id}` : info.id;
  const usage = service === 'platform' ? await fetchPlatformUsage(org.id, SERVICES.platform.origin).catch(() => null) : await fetchUsage(org.id).catch(() => null);
  const secret = cookieToSecret(accountId, cookie);

  const state = await updateState((s) => {
    const existing = s.accounts.find((a) => a.id === accountId);
    const account: Account = {
      ...existing,
      id: accountId,
      service,
      email: info.email,
      displayName: info.displayName,
      orgId: org.id,
      orgName: org.name,
      plan: org.plan,
      addedAt: existing?.addedAt ?? Date.now(),
      lastUsedAt: Date.now(),
      usage,
      sessionExpired: false,
    };
    const accounts = existing ? s.accounts.map((a) => (a.id === accountId ? account : a)) : [...s.accounts, account];
    const secrets = [...s.secrets.filter((sec) => sec.accountId !== accountId), secret];
    return {
      ...s,
      accounts,
      secrets,
      ...(service === 'platform' ? { activePlatformAccountId: accountId } : { activeAccountId: accountId }),
    };
  });

  return state.accounts.find((a) => a.id === accountId)!;
}

/**
 * Switches the active session (for whichever service `accountId` belongs to) to that account.
 * Parks every open tab on that service's origin on our own static page BEFORE touching any cookie
 * (see `parkServiceTabs` — this is what stops the old SPA from killing the new session with its own
 * involuntary-logout call), refreshes the outgoing account's stored secret (sessions rotate), sets
 * the target's cookie preserving the live cookie's flags (secure/httpOnly/sameSite, domain unless
 * host-only) and the target's own stored expiry, clears that origin's site storage (not cookies —
 * the SPA's own cached-account state, not the session itself), then sends the parked tabs to a
 * neutral landing page (never back to the outgoing account's conversation/workspace URL).
 *
 * Tabs are now ALWAYS parked and restored this way — `settings.reloadClaudeTabsOnSwitch` (a plain
 * reload, with the old SPA still running throughout) is what caused the repeated-logout bug in the
 * first place, so that setting is no longer consulted here. The key is kept in `StorageSchema` for
 * backward compatibility with existing exports/options pages that still read/write it.
 */
export async function switchAccount(accountId: string, reason: SwitchEvent['reason'] = 'manual', ruleId?: string): Promise<void> {
  const state = await loadState();
  const target = state.accounts.find((a) => a.id === accountId);
  const targetSecret = state.secrets.find((s) => s.accountId === accountId);
  if (!target || !targetSecret) throw new Error(`Unknown account: ${accountId}`);
  if (target.sessionExpired) throw new Error(`${target.displayName || target.email}'s session has expired — log in again to use this account.`);
  if (targetSecret.expirationDate !== undefined && targetSecret.expirationDate * 1000 < Date.now()) {
    throw new Error(`${target.displayName || target.email}'s saved session has expired — log in again to use this account.`);
  }
  const service = serviceOf(target);
  if (!(await canUseService(service))) throw new Error(PLATFORM_PERMISSION_ERROR);

  const parkedTabIds = await parkServiceTabs(service);

  const outgoingCookie = await getCurrentSessionCookie(service);
  if (outgoingCookie) await reconcileLiveSessionOwnership(outgoingCookie, service);

  await setSessionCookie(targetSecret, outgoingCookie, service);
  await syncLastActiveOrgCookie(target.orgId, service);
  await clearServiceSiteStorage(service);
  if (parkedTabIds.length > 0) await sendParkedTabsTo(parkedTabIds, LANDING_URL[service]);

  await updateState((s) => {
    const fromAccountId = service === 'platform' ? s.activePlatformAccountId : s.activeAccountId;
    const event: SwitchEvent = { service, at: Date.now(), fromAccountId, toAccountId: accountId, reason, ruleId };
    const withHistory = pushHistory(
      { ...s, ...(service === 'platform' ? { activePlatformAccountId: accountId } : { activeAccountId: accountId }) },
      event,
    );
    return { ...withHistory, accounts: withHistory.accounts.map((a) => (a.id === accountId ? { ...a, lastUsedAt: Date.now() } : a)) };
  });
}

/** Saves the current session for `service` (if any), clears its cookie, and opens its login page.
 * Parks any open tabs on that origin first (same reasoning as `switchAccount` — stops the old SPA
 * from running while the cookie is removed) and sends them straight to the login page afterwards,
 * rather than opening a separate new tab when there's already one to reuse. */
export async function addAccountFlow(service: Service = 'claude'): Promise<void> {
  if (!(await canUseService(service))) throw new Error(PLATFORM_PERMISSION_ERROR);
  const parkedTabIds = await parkServiceTabs(service);

  const cookie = await getCurrentSessionCookie(service);
  if (cookie) await reconcileLiveSessionOwnership(cookie, service);
  await setPendingAddAccount(service, true);
  await removeSessionCookie(service);
  await clearServiceSiteStorage(service);

  if (parkedTabIds.length > 0) await sendParkedTabsTo(parkedTabIds, SERVICES[service].loginUrl);
  else await chrome.tabs.create({ url: SERVICES[service].loginUrl });
}

/**
 * Called whenever a `service`'s `sessionKey` cookie changes. If the new value doesn't match any
 * saved secret and an `addAccountFlow` for that service is pending, captures it as a new account
 * automatically.
 */
export async function handleSessionCookieChanged(cookie: chrome.cookies.Cookie, service: Service): Promise<void> {
  const state = await loadState();
  const alreadySaved = state.secrets.some((s) => s.sessionKey === cookie.value);
  if (alreadySaved) return;
  if (!(await isPendingAddAccount(service))) return;

  await setPendingAddAccount(service, false);
  try {
    await captureCurrentAccount(service);
  } catch {
    // The login flow may still be mid-redirect (e.g. an intermediate cookie value) — let the next
    // cookie change retry.
    await setPendingAddAccount(service, true);
  }
}

async function handleCookieChange(changeInfo: chrome.cookies.CookieChangeInfo): Promise<void> {
  if (changeInfo.removed) return;
  if (changeInfo.cookie.name !== SESSION_COOKIE_NAME) return;
  const service = serviceForCookieDomain(changeInfo.cookie.domain);
  if (!service) return;
  await handleSessionCookieChanged(changeInfo.cookie, service);
}

chrome.cookies.onChanged.addListener(handleCookieChange);
