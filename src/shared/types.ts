// Shared data contracts between the background service worker and the extension pages.

/** One usage window as reported by claude.ai (`/api/organizations/{org}/usage`). */
export interface UsageWindow {
  /** 0–100 percent of the window's limit used. */
  utilization: number;
  /** ISO timestamp when the window resets, or null if not started. */
  resetsAt: string | null;
}

/**
 * Generic limit entry from the `limits` array of the usage payload (verified 2026-10-12).
 * This is the most future-proof source: claude.ai lists every active limit here, e.g.
 * `{kind:'session', group:'session', percent:22, severity:'normal', resets_at, scope:null, is_active:true}`
 * `{kind:'weekly_scoped', group:'weekly', percent:0, scope:{model:{display_name:'Fable'}}, is_active:false}`.
 * Note: `limits` may arrive as an array OR as an object keyed "0","1",… — normalize both.
 */
export interface UsageLimit {
  kind: string; // 'session' | 'weekly' | 'weekly_scoped' | ...
  group: string; // 'session' | 'weekly' | ...
  percent: number; // 0–100
  severity: string; // 'normal' | 'warning' | 'critical' | ...
  resetsAt: string | null;
  /** Human label derived from scope, e.g. "Fable" for a model-scoped weekly limit. */
  scopeLabel: string | null;
  isActive: boolean;
}

export interface UsageSnapshot {
  fetchedAt: number; // epoch ms
  /** Normalized `limits` entries (preferred source for UI). */
  limits: UsageLimit[];
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDayOpus: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  /** Platform accounts only (informational; no limits, rules or notifications). `limits` stays []. */
  billing?: PlatformBilling | null;
  /** Pay-as-you-go extra usage, when enabled on the org. */
  extraUsage: { enabled: boolean; utilization: number | null; spendLimitReached: boolean } | null;
  /** Raw payload kept for forward-compat/debugging (never synced, never logged). */
  raw?: unknown;
}

/**
 * Which Anthropic web product an account belongs to. Sessions are separate per product:
 * claude.ai (chat, plan usage limits) and platform.claude.com (Claude Platform / Console: API
 * credits, monthly spend). Verified 2026-10-12: both use an httpOnly `sessionKey` cookie on their own
 * host, plus a `lastActiveOrg` cookie (claude.ai: on claude.ai; platform: on `.claude.com`).
 */
export type Service = 'claude' | 'platform';

export const SERVICES: Record<Service, { label: string; origin: string; loginUrl: string }> = {
  claude: { label: 'Claude.ai', origin: 'https://claude.ai', loginUrl: 'https://claude.ai/login' },
  platform: { label: 'Claude Platform', origin: 'https://platform.claude.com', loginUrl: 'https://platform.claude.com/login' },
};

/**
 * platform.claude.com is an OPTIONAL host permission: requested from the popup (user gesture) when
 * the user opts into Platform support. Without it, every platform operation is skipped.
 */
export const PLATFORM_ORIGIN_PATTERN = 'https://platform.claude.com/*';

/** Account.service is optional for data saved before platform support; missing means 'claude'. */
export function serviceOf(account: { service?: Service }): Service {
  return account.service ?? 'claude';
}

/**
 * Claude Platform spend, shown as a single informational line ("$210.50 spent this month").
 * Platform support is about account management/switching; usage is deliberately minimal.
 * Source (verified 2026-10-12): `GET /api/organizations/{uuid}/current_spend` → `{ amount, resets_at }`,
 * amount in CENTS, on the org that has the `api` capability. Best effort: null when unavailable.
 */
export interface PlatformBilling {
  spendCents: number | null;
  spendResetsAt: string | null;
  /** The API org's `api_disabled_reason` (e.g. "out_of_credits"), from the organizations list. */
  apiDisabledReason: string | null;
}

/** Per-product notification preferences (chrome.notifications). */
export interface NotificationSettings {
  claude: {
    enabled: boolean;
    /** Notify when the active account crosses these usage percents (any limit). */
    usageThresholds: number[];
    /** Notify when a limit is reached (100% / locked). */
    limitReached: boolean;
    /** Notify when a rule switched accounts automatically. */
    autoSwitch: boolean;
    /** Notify when a saved session stops working and needs a new sign-in. */
    sessionExpired: boolean;
  };
  platform: {
    enabled: boolean;
    /** Notify when the active Platform account's monthly spend crosses these amounts (cents). */
    spendThresholdsCents: number[];
    /** Notify when the API gets disabled for the org (e.g. out of credits). */
    apiDisabled: boolean;
    sessionExpired: boolean;
  };
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  claude: { enabled: true, usageThresholds: [80, 95], limitReached: true, autoSwitch: true, sessionExpired: true },
  platform: { enabled: true, spendThresholdsCents: [], apiDisabled: true, sessionExpired: true },
};

export type PlanTier = 'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'unknown';

export interface Account {
  /**
   * Stable id. claude.ai accounts: the account uuid (unchanged from v0.1). Platform accounts:
   * `platform:<account uuid>` — the same person can have both, and they are separate sessions.
   */
  id: string;
  /** Missing = 'claude' (data saved before platform support). Use serviceOf(). */
  service?: Service;
  email: string;
  displayName: string;
  /** Active organization uuid used for usage lookups. */
  orgId: string;
  orgName: string;
  plan: PlanTier;
  /** User-chosen label + color for the popup. */
  label?: string;
  color?: string;
  /** Excluded from auto-switch rotation when true. */
  paused?: boolean;
  addedAt: number;
  lastUsedAt: number | null;
  usage: UsageSnapshot | null;
  /** Set when the stored session was rejected (401/403) and needs re-login. */
  sessionExpired?: boolean;
  /** Set when a usage refresh failed in a way that's ambiguous (e.g. the non-active-account
   * declarativeNetRequest cookie override didn't apply) — unlike `sessionExpired`, this does NOT
   * necessarily mean the session is dead, so it never forces a re-login prompt by itself. */
  usageError?: string;
}

/** Secret material, stored ONLY in chrome.storage.local under `secrets`, never synced or exported unencrypted. */
export interface AccountSecret {
  accountId: string;
  sessionKey: string; // value of the claude.ai `sessionKey` cookie
  /** Expiry of the cookie (epoch seconds) if known. */
  expirationDate?: number;
}

/** 'maxAny' = highest percent across all `limits` + legacy windows (recommended default for rules). */
export type UsageMetric = 'maxAny' | 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';

export type RuleCondition =
  | { type: 'usageAbove'; metric: UsageMetric; percent: number }
  | { type: 'limitReached' } // claude.ai reported a hard rate-limit for the active account
  | { type: 'schedule'; cron: string }; // simple "HH:MM" daily or cron-ish, see rules engine

export type RuleTarget =
  | { type: 'next' } // round-robin over eligible accounts
  | { type: 'lowestUsage'; metric: UsageMetric }
  | { type: 'specific'; accountId: string }
  | { type: 'priority' }; // first eligible account in user-defined order

export interface SwitchRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: RuleCondition;
  target: RuleTarget;
  /** Only accounts whose metric is below this percent are eligible targets. */
  targetMaxPercent?: number;
  /** Minimum minutes between two automatic switches caused by this rule. */
  cooldownMinutes: number;
  /** Ask via notification instead of switching silently. */
  confirm: boolean;
}

export interface Settings {
  pollIntervalMinutes: number; // usage polling, >= 1
  /** @deprecated since 0.2 — migrated into `notifications.claude.usageThresholds`; kept only for reading old data. */
  notifyAtPercent?: number[];
  notifications: NotificationSettings;
  autoSwitchEnabled: boolean;
  reloadClaudeTabsOnSwitch: boolean;
  showBadge: boolean;
  badgeMetric: UsageMetric;
  accountOrder: string[]; // account ids, priority order
  theme: 'system' | 'light' | 'dark';
}

export interface SwitchEvent {
  /** Missing = 'claude'. */
  service?: Service;
  at: number;
  fromAccountId: string | null;
  toAccountId: string;
  reason: 'manual' | 'rule' | 'shortcut';
  ruleId?: string;
}

/** Shape of chrome.storage.local. */
export interface StorageSchema {
  schemaVersion: 1;
  accounts: Account[];
  secrets: AccountSecret[];
  /** Active claude.ai account. */
  activeAccountId: string | null;
  /** Active Claude Platform account (switched independently of claude.ai). */
  activePlatformAccountId: string | null;
  rules: SwitchRule[];
  settings: Settings;
  history: SwitchEvent[]; // capped at 200, newest first
  lastRuleFire: Record<string, number>; // ruleId -> epoch ms
}

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMinutes: 5,
  notifications: DEFAULT_NOTIFICATIONS,
  autoSwitchEnabled: false,
  reloadClaudeTabsOnSwitch: true,
  showBadge: true,
  badgeMetric: 'maxAny',
  accountOrder: [],
  theme: 'system',
};
