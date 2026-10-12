// Talks to the unofficial claude.ai / platform.claude.com web APIs using the browser's current
// session. Both hosts share the same API family (verified 2026-10-12): `/api/account` and
// `/api/organizations` have identical shapes on each; only the usage-ish endpoints differ
// (claude.ai: `/api/organizations/{org}/usage`; platform: `current_spend`, see the
// "platform billing" section below). Every function here that calls the
// API takes an explicit `origin` (defaulting to claude.ai for backward compatibility), so the same
// code path serves both services — see `src/shared/types.ts`'s `SERVICES`.
//
// Endpoints are unofficial, undocumented, and not guaranteed stable; every parser here tolerates
// missing/renamed fields rather than throwing, except for a 401/403 response, which always means the
// session cookie is no longer valid and is surfaced as `SessionExpiredError`.
import type { PlanTier, PlatformBilling, UsageLimit, UsageSnapshot, UsageWindow } from '../shared/types';

const DEFAULT_ORIGIN = 'https://claude.ai';

export class SessionExpiredError extends Error {
  constructor() {
    super('claude.ai session is no longer valid (401/403)');
    this.name = 'SessionExpiredError';
  }
}

/** Thrown when the declarativeNetRequest session-rule mechanism itself couldn't be installed (the
 * browser rejected `updateSessionRules`) — distinct from a 401/403, which could just as easily mean
 * the override silently didn't apply. See `fetchUsageWithSessionOverride`. */
export class DnrUnavailableError extends Error {
  constructor(cause: string) {
    super(`declarativeNetRequest session rule could not be installed: ${cause}`);
    this.name = 'DnrUnavailableError';
  }
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
  if (!res.ok) throw new Error(`claude.ai request failed: ${res.status} ${url}`);
  return res.json();
}

// Every usage fetch (active-account plain fetch AND non-active-account DNR-override fetch) is
// serialized through this single queue. This is what guarantees a declarativeNetRequest session
// rule set up for one account's override can never still be in effect while ANOTHER usage fetch
// (active or override) is in flight — the root cause of rules clobbering each other, wrong cookies
// being sent, and the active account's own fetch accidentally matching a leftover override rule.
let usageFetchQueue: Promise<unknown> = Promise.resolve();
function serializeUsageFetch<T>(fn: () => Promise<T>): Promise<T> {
  const run = usageFetchQueue.then(fn, fn);
  usageFetchQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---- /api/account ----------------------------------------------------------------------------

export interface AccountInfo {
  id: string;
  email: string;
  displayName: string;
}

export function parseAccountInfo(raw: unknown): AccountInfo {
  const r = asRecord(raw);
  const email = asString(r.email_address);
  const displayName = asString(r.full_name) || asString(r.display_name) || email;
  return { id: asString(r.uuid), email, displayName };
}

export async function fetchAccountInfo(origin: string = DEFAULT_ORIGIN): Promise<AccountInfo> {
  return parseAccountInfo(await getJson(`${origin}/api/account`));
}

// ---- /api/organizations -----------------------------------------------------------------------

export interface OrgInfo {
  id: string;
  name: string;
  plan: PlanTier;
  capabilities: string[];
  /** Platform-only in practice (e.g. `"out_of_credits"`); null when the API doesn't report one. */
  apiDisabledReason: string | null;
}

/** Best-effort plan derivation from an org's `capabilities` list (+ `raven_type` for team/enterprise). */
export function derivePlanTier(capabilities: unknown, ravenType: unknown): PlanTier {
  const caps = Array.isArray(capabilities) ? capabilities.map((c) => String(c)) : [];
  if (caps.includes('raven')) return ravenType === 'enterprise' ? 'enterprise' : 'team';
  if (caps.includes('claude_max')) return 'max';
  if (caps.includes('claude_pro')) return 'pro';
  if (caps.includes('chat')) return 'free';
  return 'unknown';
}

export function parseOrganizations(raw: unknown): OrgInfo[] {
  if (!Array.isArray(raw)) return [];
  const orgs: OrgInfo[] = [];
  for (const entry of raw) {
    const r = asRecord(entry);
    const id = asString(r.uuid);
    if (!id) continue;
    const capabilities = Array.isArray(r.capabilities) ? r.capabilities.map((c) => String(c)) : [];
    orgs.push({
      id,
      name: asString(r.name),
      plan: derivePlanTier(r.capabilities, r.raven_type),
      capabilities,
      apiDisabledReason: typeof r.api_disabled_reason === 'string' ? r.api_disabled_reason : null,
    });
  }
  return orgs;
}

export async function fetchOrganizations(origin: string = DEFAULT_ORIGIN): Promise<OrgInfo[]> {
  return parseOrganizations(await getJson(`${origin}/api/organizations`));
}

// ---- /api/organizations/{orgUuid}/usage --------------------------------------------------------

function parseWindow(raw: unknown): UsageWindow | null {
  if (raw === null || raw === undefined) return null;
  const r = asRecord(raw);
  if (typeof r.utilization !== 'number') return null;
  const resetsAt = r.resets_at;
  return { utilization: r.utilization, resetsAt: typeof resetsAt === 'string' ? resetsAt : null };
}

/** `limits` arrives as either a JSON array or an object keyed "0","1",… — normalize both to an array. */
function normalizeLimitsList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null) {
    return Object.keys(raw as Record<string, unknown>)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => (raw as Record<string, unknown>)[key]);
  }
  return [];
}

function parseScopeLabel(raw: unknown): string | null {
  const scope = asRecord(raw).model;
  if (!scope) return null;
  const displayName = asRecord(scope).display_name;
  return typeof displayName === 'string' ? displayName : null;
}

function parseLimit(raw: unknown): UsageLimit {
  const r = asRecord(raw);
  const resetsAt = r.resets_at;
  return {
    kind: asString(r.kind),
    group: asString(r.group),
    percent: typeof r.percent === 'number' ? r.percent : 0,
    severity: asString(r.severity, 'normal'),
    resetsAt: typeof resetsAt === 'string' ? resetsAt : null,
    scopeLabel: parseScopeLabel(r.scope),
    isActive: Boolean(r.is_active),
  };
}

function parseExtraUsage(raw: unknown): UsageSnapshot['extraUsage'] {
  if (raw === undefined || raw === null) return null;
  const r = asRecord(raw);
  return {
    enabled: Boolean(r.is_enabled),
    utilization: typeof r.utilization === 'number' ? r.utilization : null,
    spendLimitReached: Boolean(r.spend_limit_reached),
  };
}

export function parseUsageSnapshot(raw: unknown, fetchedAt: number): UsageSnapshot {
  const r = asRecord(raw);
  return {
    fetchedAt,
    limits: normalizeLimitsList(r.limits).map(parseLimit),
    fiveHour: parseWindow(r.five_hour),
    sevenDay: parseWindow(r.seven_day),
    sevenDayOpus: parseWindow(r.seven_day_opus),
    sevenDaySonnet: parseWindow(r.seven_day_sonnet),
    extraUsage: parseExtraUsage(r.extra_usage),
    raw,
  };
}

export async function fetchUsage(orgId: string, origin: string = DEFAULT_ORIGIN): Promise<UsageSnapshot> {
  return serializeUsageFetch(async () => {
    const json = await getJson(`${origin}/api/organizations/${orgId}/usage`);
    return parseUsageSnapshot(json, Date.now());
  });
}

// ---- Usage for non-active accounts, via a declarativeNetRequest session rule -------------------
//
// The active account's usage is fetched normally (`fetchUsage`, using the browser's real
// `sessionKey` cookie). For every OTHER saved account we don't want to touch that real cookie, so
// instead we install a temporary `declarativeNetRequest` session rule that forces a `Cookie` header
// onto just this one extension-initiated request (scoped by `initiatorDomains: [chrome.runtime.id]`
// and `tabIds: [chrome.tabs.TAB_ID_NONE]`, so it can never affect a request made from a real tab),
// fetch with `credentials: 'omit'` so the browser's own cookie never attaches, then remove the rule.
// Every call gets its OWN rule id (`allocateOverrideRuleId`) and removes only that id — never a
// fixed id — and the whole add→fetch→remove sequence is serialized (`serializeUsageFetch`, shared
// with the plain `fetchUsage` above) so two overrides, or an override and the active fetch, can
// never have rules installed at the same time. Without both of these, two accounts polled
// concurrently (or sharing the same org) could get each other's Cookie header, and the active
// account's own plain fetch could accidentally match a still-installed override rule.
//
// This has been implemented and code-reviewed against the documented DNR `modifyHeaders` action,
// but NOT live-verified in a real Chrome session (no interactive browser available while building
// this). If installing the rule itself fails, that's surfaced as `DnrUnavailableError` (a capability
// signal scheduler.ts uses to stop trying); a 401/403 from the fetch is still `SessionExpiredError`
// but is deliberately NOT treated as proof the session is dead here, since the override may simply
// not have applied — see scheduler.ts's `usageError` handling.
const OVERRIDE_RULE_ID_MIN = 90_000;
const OVERRIDE_RULE_ID_MAX = 99_999;
let nextOverrideRuleId = OVERRIDE_RULE_ID_MIN;

function allocateOverrideRuleId(): number {
  const id = nextOverrideRuleId;
  nextOverrideRuleId = id >= OVERRIDE_RULE_ID_MAX ? OVERRIDE_RULE_ID_MIN : id + 1;
  return id;
}

/** Installs a session DNR rule matching `urlFilter`, runs `fn`, then removes the rule — serialized
 * (shared `serializeUsageFetch` queue) with every other usage fetch regardless of which service it's
 * for, so two overrides (or an override and a plain fetch) can never be installed at once. */
async function withSessionOverride<T>(urlFilter: string, sessionKey: string, fn: () => Promise<T>): Promise<T> {
  return serializeUsageFetch(async () => {
    const ruleId = allocateOverrideRuleId();
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: ruleId,
            priority: 1,
            condition: {
              urlFilter,
              resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
              initiatorDomains: [chrome.runtime.id],
              tabIds: [chrome.tabs.TAB_ID_NONE],
            },
            action: {
              type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
              requestHeaders: [{ header: 'Cookie', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: `sessionKey=${sessionKey}` }],
            },
          },
        ],
      });
    } catch (err) {
      throw new DnrUnavailableError(err instanceof Error ? err.message : String(err));
    }
    try {
      return await fn();
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => undefined);
    }
  });
}

export async function fetchUsageWithSessionOverride(orgId: string, sessionKey: string, origin: string = DEFAULT_ORIGIN): Promise<UsageSnapshot> {
  const host = new URL(origin).host;
  return withSessionOverride(`||${host}/api/organizations/${orgId}/usage`, sessionKey, async () => {
    const json = await getJson(`${origin}/api/organizations/${orgId}/usage`, { credentials: 'omit' });
    return parseUsageSnapshot(json, Date.now());
  });
}

// ---- Claude Platform billing (minimal — account management/switching is the point) -------------
//
// By design, platform support is about account management, not
// usage tracking, so this is deliberately minimal — a single "$X spent this month" figure, not a
// percent or a limit. No synthetic `limits` entry, no rules-engine involvement.
// `GET /api/organizations/{org}/current_spend` → `{ amount, resets_at }` (amount in CENTS); best
// effort — a non-auth failure here yields `spendCents: null` rather than failing the whole refresh.
// `api_disabled_reason` comes from the org's own entry in `/api/organizations` (see `OrgInfo`) — no
// extra endpoint call. Only the ACTIVE platform account is ever refreshed; non-active platform
// accounts keep their last known value (no declarativeNetRequest polling for them — see scheduler.ts).

export function parseCurrentSpend(raw: unknown): { amountCents: number | null; resetsAt: string | null } {
  const r = asRecord(raw);
  return { amountCents: typeof r.amount === 'number' ? r.amount : null, resetsAt: typeof r.resets_at === 'string' ? r.resets_at : null };
}

export function buildPlatformBilling(currentSpendRaw: unknown, apiDisabledReason: string | null): PlatformBilling {
  const spend = parseCurrentSpend(currentSpendRaw);
  return { spendCents: spend.amountCents, spendResetsAt: spend.resetsAt, apiDisabledReason };
}

export function buildPlatformUsageSnapshot(billing: PlatformBilling, fetchedAt: number): UsageSnapshot {
  return { fetchedAt, limits: [], fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, billing, extraUsage: null };
}

export async function fetchPlatformUsage(orgId: string, origin: string): Promise<UsageSnapshot> {
  return serializeUsageFetch(async () => {
    const org = parseOrganizations(await getJson(`${origin}/api/organizations`)).find((o) => o.id === orgId);
    let currentSpendJson: unknown = null;
    try {
      currentSpendJson = await getJson(`${origin}/api/organizations/${orgId}/current_spend`);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err; // a real auth problem — let it surface
      currentSpendJson = null; // best effort otherwise (e.g. the org doesn't expose spend)
    }
    return buildPlatformUsageSnapshot(buildPlatformBilling(currentSpendJson, org?.apiDisabledReason ?? null), Date.now());
  });
}

/** Best-effort cleanup of any override rule left behind by a service worker that was killed
 * mid-fetch. Call once on startup. */
export async function clearLeftoverUsageOverrideRules(): Promise<void> {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const leftoverIds = rules.map((r) => r.id).filter((id) => id >= OVERRIDE_RULE_ID_MIN && id <= OVERRIDE_RULE_ID_MAX);
    if (leftoverIds.length > 0) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: leftoverIds });
  } catch {
    // Best-effort only.
  }
}
