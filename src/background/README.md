# Background service worker

This is the MV3 service worker for "Switchboard for Claude". `index.ts` is the bundle entry
(`background.js`); every other file here is imported by it for its side effects and/or used by
`router.ts` to answer popup/options messages.

## Two services

The extension manages accounts for two separate Anthropic web products — claude.ai (chat) and
platform.claude.com (Claude Platform / Console: API credits, monthly spend) — see `Service`,
`SERVICES`, and `serviceOf()` in `src/shared/types.ts`. Each has its own origin, its own httpOnly
`sessionKey` cookie, and its own "active account" field in `StorageSchema`
(`activeAccountId`/`activePlatformAccountId`), switched independently. A platform account's id is
always `platform:<uuid>` (the same person can have both a claude.ai and a platform account sharing
the same underlying uuid — the prefix keeps them distinct everywhere an id is used as a key).
`captureCurrentAccount`, `addAccountFlow`, and `switchToNext` all take an optional `service`
parameter (default `'claude'`); `switchAccount` and `refreshUsage` infer the service from the target
account itself (`serviceOf(account)`), since an account id is already service-specific.

Platform support is deliberately about **account management**, not usage tracking: its `billing` is
a single informational `{ spendCents, spendResetsAt, apiDisabledReason }` (no synthetic `limits`
entry), and the auto-switch rules engine + toolbar badge stay claude.ai-only — see `rules.ts` and
`scheduler.ts`'s `updateBadge()` below.

**`platform.claude.com` is an *optional* host permission** (`public/manifest.json`'s
`optional_host_permissions`, requested from the popup via `chrome.permissions.request()` when the
user opts into Platform support — a background service worker has no user gesture to call that
itself). Without it granted, `chrome.cookies.get`/`.set`/`.remove` for that origin throw
`"No host permissions for cookies at url: ..."` — see `permissions.ts` below for how every
platform-touching code path in this directory guards against that.

**Unverified: the platform `sessionKey` cookie's exact domain scope.** It may be host-only to
`platform.claude.com`, or it may be scoped to the registrable domain `.claude.com` (unconfirmed
either way). `session.ts` handles both: `isCookieDomainFor('platform', domain)` accepts either form
when routing a changed `sessionKey` cookie to the platform service (so `addAccountFlow` auto-capture
works regardless), and `setSessionCookie`/`syncLastActiveOrgCookie` always reuse whatever domain the
*live* cookie already has rather than assuming one. If it does turn out to be scoped to `.claude.com`,
switching the platform account also changes the session on any other `*.claude.com` site sharing that
cookie — documented for users in the main `README.md`'s "How account switching works".

## Module map

- **`storage.ts`** — the entire `StorageSchema` (src/shared/types.ts) lives under one
  `chrome.storage.local` key (`"state"`), so a read-modify-write cycle is one `get` + one `set`.
  `loadState()` fills in defaults for anything missing (first run, or an older/partial record) and,
  on a genuinely fresh install (no record at all), persists those defaults immediately rather than
  only holding them in memory. `updateState(mutator)` serializes every read-modify-write through a
  promise queue so a poll tick and a popup message that land at the same time can't clobber each
  other. `history` is capped at 200 entries (newest first). Secrets (`AccountSecret[]`) live in this
  same `storage.local` record — never in `storage.sync`, never copied into `PublicState` (see
  `router.ts`). `mergeSettings(base, patch)` deep-merges `settings.notifications.claude`/`.platform`
  individually (so a partial patch to one service's notifications can't wipe the other's) and migrates
  the deprecated `settings.notifyAtPercent` into `notifications.claude.usageThresholds` the first time
  it's seen; both `migrate()` and `router.ts`'s `saveSettings`/`importData` go through it.

- **`claudeApi.ts`** — talks to the unofficial `https://claude.ai/api/*` and
  `https://platform.claude.com/api/*` endpoints (same API family on each host, verified
  2026-10-12 — the raw shapes are documented in `src/shared/types.ts`) using the browser's current session
  (`credentials: 'include'`). Every exported function that calls the API takes an explicit `origin`
  (defaulting to claude.ai for the original functions, so existing call sites are unaffected) so the
  same code path serves both services. Every parser (`parseAccountInfo`, `parseOrganizations`,
  `parseUsageSnapshot`, `derivePlanTier`, `parseCurrentSpend`, `buildPlatformBilling`) is a pure
  function of the raw JSON, tested against fixture-shaped payloads independently of `fetch`. A
  401/403 always throws `SessionExpiredError`, which callers use to flag `Account.sessionExpired` —
  except on claude.ai's non-active-account override path, see below.

  Endpoints used (unofficial, undocumented; may change without notice):
  - `GET /api/account` → `{ uuid, email_address, full_name, ... }` (identical shape on both hosts).
  - `GET /api/organizations` → `[{ uuid, name, capabilities: string[], api_disabled_reason, ... }]`
    (identical shape on both hosts). `derivePlanTier()` maps `capabilities`/`raven_type` to a
    `PlanTier` best-effort: `"raven"` in capabilities → `team` (or `enterprise` if
    `raven_type === 'enterprise'`), else `claude_max`/`claude_pro`/`chat` → `max`/`pro`/`free`, else
    `unknown`. `capabilities.includes('api')` is how `session.ts` picks the platform org (a
    `chat`-only org is the claude.ai one); `api_disabled_reason` (e.g. `"out_of_credits"`) feeds
    `PlatformBilling.apiDisabledReason`.
  - claude.ai `GET /api/organizations/{orgUuid}/usage` → legacy `five_hour`/`seven_day`/
    `seven_day_opus`/`seven_day_sonnet` windows (`seven_day` can be `null` even on paid plans) plus a
    `limits` array (or an object keyed `"0"`, `"1"`, … — both shapes are normalized) that is the more
    future-proof source of truth; `UsageMetric: 'maxAny'` takes the highest percent across all of it.
  - platform `GET /api/organizations/{orgUuid}/current_spend` → `{ amount, resets_at }` (amount in
    CENTS). `fetchPlatformUsage()` combines this with the org's `api_disabled_reason` into a
    `UsageSnapshot` whose `limits` stays `[]` — platform billing is informational only (see "Two
    services" above), not a percent fed into any rule or badge. A non-auth failure here yields
    `spendCents: null` rather than failing the whole refresh (best effort); a 401/403 still throws
    `SessionExpiredError` normally, since the session itself being dead is unambiguous.

  **Usage for non-active accounts** (`fetchUsageWithSessionOverride`, claude.ai only — platform
  accounts have no equivalent, see "Two services" above): we don't want to touch the
  real browsing cookie just to poll an account that isn't currently logged in. Instead we install a
  temporary `declarativeNetRequest` **session** rule that forces a `Cookie: sessionKey=...` header
  onto one specific extension-initiated request — scoped by `initiatorDomains: [chrome.runtime.id]`
  and `tabIds: [chrome.tabs.TAB_ID_NONE]` so it can never touch a request from a real tab — fetch
  with `credentials: 'omit'` so the browser's own cookie never attaches, then remove the rule in a
  `finally`. Every call gets its own rule id (cycled through a reserved `90000–99999` range) and
  removes only that id, and the whole add→fetch→remove sequence — for every usage fetch, including
  the plain active-account one — is serialized through a single module-level queue
  (`serializeUsageFetch`), so two overrides, or an override and the active fetch, can never have
  rules installed at the same time; `clearLeftoverUsageOverrideRules()` (called once from `index.ts`
  on startup) sweeps up any rule left behind by a service worker that was killed mid-fetch. If
  installing the rule itself fails, that's `DnrUnavailableError` — a capability signal
  `scheduler.ts` uses to stop trying for the rest of that service-worker's lifetime. A 401/403 from
  the override fetch is still `SessionExpiredError`, but `scheduler.ts` deliberately does **not**
  treat it as proof the session is dead (the override may simply not have applied) — see
  `Account.usageError` below.

  This mechanism is implemented and unit-tested against the documented DNR API shape, but **has not
  been live-verified in a real Chrome session** (no interactive browser was available while building
  this).

- **`permissions.ts`** — `hasPlatformPermission()`, the single source of truth for whether the
  optional `https://platform.claude.com/*` host permission (`PLATFORM_ORIGIN_PATTERN` in
  `src/shared/types.ts`) is currently granted, via `chrome.permissions.contains()`. Never throws
  (a rejection from `contains()` itself is treated as "not granted"). Every platform-touching
  function elsewhere in this directory calls it first: `session.ts`'s cookie read/write/capture/
  add/switch functions skip silently (background reads) or throw a clear `"Allow access to
  platform.claude.com first."` (user-initiated actions) when it's false, rather than letting
  `chrome.cookies` throw its much less helpful error; `scheduler.ts`'s active-platform-account usage
  fetch skips the same way; `router.ts` exposes it directly as `PublicState.platformPermission` so
  the popup knows whether to show a "connect Platform" prompt instead of just reacting to failures.

- **`session.ts`** — cookie management for the `sessionKey` cookie via `chrome.cookies`, generalized
  over both services via `SERVICES[service].origin` (each service's cookie lives on its own origin,
  independent of the other's).
  - `captureCurrentAccount(service = 'claude')` reads the current cookie for that service, calls the
    API, and upserts the `Account` + `AccountSecret` (preserving `label`/`color`/`paused`/`addedAt`
    across re-capture; the account id is `platform:<uuid>` for `service: 'platform'`, setting
    `activePlatformAccountId` instead of `activeAccountId`). Throws if the API returns no account id.
    Picks which org to track via `pickOrganization()`: for claude.ai, the org matching its own
    `lastActiveOrg` cookie if present, else the first non-free/non-unknown ("paid") org, else simply
    the first one; for platform, only orgs with the `api` capability are eligible at all (throws if
    none are), then the same `lastActiveOrg`-match-else-first preference among those.
  - **`switchAccount(id)` parks that service's open tabs BEFORE touching any cookie, and clears that
    origin's site storage (not cookies) after swapping it** — the fix for a bug (2026-10-12) where
    switching logged the user out 2-3 times: claude.ai's SPA caches which account is logged in
    outside of cookies (`rq-cache-confirmed-account*`, `__qk_hint_account_uuid`, …) and, left running
    through the swap, would see auth errors against its stale cache and call its own
    `/logout?involuntary=1` — which kills the BRAND-NEW session server-side, not the old one. The
    full sequence: `parkServiceTabs(service)` finds every open tab on that origin
    (`chrome.tabs.query`) and navigates each (`chrome.tabs.update`) to the bundled static
    `switching/index.html` page, waiting (with a `PARK_TIMEOUT_MS` fallback) for each to actually
    finish loading it — this is what stops the old SPA from running at all — *then* the usual
    cookie-reconciliation/set/`lastActiveOrg`-sync happens, *then* `clearServiceSiteStorage(service)`
    wipes that origin's `localStorage`/`indexedDB`/`cacheStorage`/service-workers via the
    `browsingData` permission (scoped to that one origin, explicitly never `cookies` — best-effort,
    wrapped in try/catch, since a failure here is cosmetic, not session-destroying), and finally the
    parked tabs are sent to a neutral landing page (`https://claude.ai/new` /
    `https://platform.claude.com/` — never back to the outgoing account's conversation/workspace URL)
    via `sendParkedTabsTo`. If there were no open tabs to begin with, nothing is parked or restored.
    `settings.reloadClaudeTabsOnSwitch` (a plain reload, with the old SPA running throughout — the
    actual root cause) is **no longer consulted**: tabs are now always parked and restored this way.
    The key is kept in `StorageSchema` only for backward compatibility with existing exports/options
    pages that still read/write it.
    `switchAccount(id)` also refuses outright (clear error, no cookie touched) if the target is
    `sessionExpired` or its stored secret's `expirationDate` is already in the past, and — before
    parking — calls `reconcileLiveSessionOwnership()`: it calls `/api/account` (on that service's
    origin) to find out who the live session **actually** belongs to and refreshes **that** account's
    stored secret — never assumes it's still the active account's. If the live session belongs to a
    different saved account (the user logged in as someone else directly, outside the extension),
    that account's secret is the one refreshed; if it belongs to no saved account, or ownership can't
    be verified (e.g. the API call fails), nothing is touched — this is what used to silently
    overwrite the wrong account's secret. The target's cookie reuses the live cookie's
    `secure`/`httpOnly`/`sameSite` flags and exact `domain` when the live cookie has one (i.e. isn't
    `hostOnly`); when there's no live cookie to copy at all, or it IS `hostOnly`, the new cookie is
    created host-only too (domain omitted) rather than guessing one, since passing a `domain` always
    creates a domain-scoped cookie even for a site that only ever sets host-only ones (same reasoning
    applies to `lastActiveOrg`). It also best-effort syncs a `lastActiveOrg` cookie to the target org
    (verified live on 2026-10-12 to exist on `claude.ai`/`.claude.com` respectively and be
    non-`httpOnly`), fully wrapped in try/catch.
  - `addAccountFlow(service = 'claude')` parks that service's open tabs the same way, BEFORE removing
    the cookie, then runs the same ownership-verified secret refresh, sets a
    `pendingAddAccount:<service>` flag in `chrome.storage.session` (survives service-worker
    suspension, cleared on browser restart), removes that service's cookie, clears its site storage
    the same way as `switchAccount`, and finally either navigates the parked tabs straight to its
    login page (`SERVICES[service].loginUrl`) or, if there were no open tabs, opens a new one there.
  - A single `chrome.cookies.onChanged` listener (registered at module top level) routes by the
    changed cookie's domain to the right service (`serviceForCookieDomain`) and calls
    `handleSessionCookieChanged(cookie, service)`; if the new value doesn't match any saved secret and
    that service's `pendingAddAccount` flag is set, it auto-captures the new login as an account of
    that service.
  - `isSessionUnsaved(service, state)` — used by `router.ts` for `unsavedSessionDetected` /
    `unsavedPlatformSessionDetected` — is true when a live cookie for that service exists that matches
    no saved secret.
  - Without the optional platform host permission (`permissions.hasPlatformPermission()`),
    `getCurrentSessionCookie('platform')` returns `null` and `removeSessionCookie('platform')` is a
    no-op instead of calling `chrome.cookies`; `captureCurrentAccount`, `addAccountFlow`, and
    `switchAccount` (to a platform account) each throw `"Allow access to platform.claude.com first."`
    as their very first step. claude.ai is entirely unaffected by this check.

- **`rules.ts`** — the auto-switch rules engine, deliberately free of any `chrome.*` call so it's a
  plain, fully unit-tested function of data: `evaluateRules(input, now)`,
  `thresholdCrossings(prev, next, notifyAtPercent)`, and `nextEligibleAccount(...)`. See
  `tests/background/rules.test.ts` for branch-level coverage of every condition/target combination.
  - `isLimitReached(usage)`: true when any **active** `limits[]` entry is at ≥100%, or any legacy
    window is at ≥100%. (The shared `UsageSnapshot` type doesn't carry claude.ai's `locked_reason`
    field, so this percent-based check is the engine's own definition of "limit reached.")
  - Schedule condition (`{ type: 'schedule', cron: 'HH:MM' }`): a plain **daily local time**, not
    real cron — a malformed or out-of-range `"HH:MM"` never matches. A rule fires on the first poll
    tick at or after today's `HH:MM`, and won't fire again until a poll lands at or after
    *tomorrow's* `HH:MM` (tracked via `lastRuleFire[rule.id]`, independent of
    `settings.pollIntervalMinutes` or `cooldownMinutes`).
  - Target eligibility (`isEligibleTarget`) excludes paused, session-expired, and already
    limit-reached accounts, plus — once there's an effective `targetMaxPercent` — any account with
    unknown usage data. `targetMaxPercent` defaults to the triggering `usageAbove` condition's own
    percent when not set explicitly, so a switch never lands on an account that's just as overloaded
    as the one being switched away from (the root cause of ping-pong switching). A rule whose
    condition matches but whose target has no eligible account is skipped, not treated as a block —
    evaluation falls through to the next rule.
  - A global minimum gap (`GLOBAL_MIN_SWITCH_GAP_MINUTES`, 10 minutes, tracked via the synthetic
    `lastRuleFire[GLOBAL_SWITCH_GAP_KEY]` entry) applies across **all** rules, so two different rules
    firing in quick succession can't ping-pong the active account either.
  - `evaluateRules()` filters `input.accounts` down to claude.ai ones (`serviceOf(a) === 'claude'`)
    before doing anything else — platform accounts are never an active account or a switch target
    here, regardless of what's passed in (defense in depth, not just a caller convention).
  - `valueCrossings(prevValue, nextValue, thresholds, options?)` generalizes the crossing check to
    any numeric value, not just a usage percent (used for platform spend-in-cents thresholds too, see
    `scheduler.ts`). `options.notifyOnUnknownPrev` (default `true`) controls what a `null` previous
    value means: `true` (claude's percent thresholds) treats it as "below every threshold", so a
    first-ever read that's already high still notifies; `false` (platform spend) instead treats it as
    "no baseline yet" and reports no crossings, since a brand-new account's first spend reading isn't
    a meaningful crossing. `thresholdCrossings()` is `valueCrossings` specialized to the `maxAny`
    percent (with the default `notifyOnUnknownPrev: true`).

- **`scheduler.ts`** — `chrome.alarms` (`usagePoll`, `periodInMinutes` from
  `settings.pollIntervalMinutes`, clamped to a whole number ≥ 1 by `sanitizePollInterval`).
  `schedulePolling()` only calls `chrome.alarms.create` when the alarm is missing or its period
  actually changed, so calling it on every service-worker wake can't reset an otherwise-stable
  alarm's schedule.
  - `refreshUsage()` is serialized through a module-level queue (`refreshQueue`): an alarm-triggered
    poll and a popup-triggered refresh (or two overlapping alarm ticks) can never run concurrently.
    Without this, two calls could both read the same `prevUsage` before either writes back and
    independently fire the same threshold notification twice.
  - For each service's active account, if there's no live `sessionKey` cookie **at all** right now
    (mid `addAccountFlow`, a direct logout, a closed tab, …), that account's fetch is skipped
    entirely — it says nothing about whether the *saved* session is still valid, so this never flips
    `sessionExpired` and never notifies; the account just keeps its last known value until a future
    poll finds a live cookie again. If a live cookie *is* present but doesn't match the active
    account's stored secret (someone logged into that service as a different account directly), the
    claude.ai account falls back to its DNR-override path using the stored secret instead; platform
    has no such fallback and just skips (no DNR override exists for platform — see `claudeApi.ts`).
    After all fetches settle, if either service's active-account id changed mid-refresh (a switch
    raced in concurrently), the whole batch of results is discarded rather than written under a
    now-stale assumption. A failed refresh never blindly sets `sessionExpired` for a non-active
    claude.ai account — a 401/403 or a `DnrUnavailableError` on that path instead sets
    `Account.usageError` (a human-readable string) and leaves `sessionExpired` untouched, since the
    override not applying looks identical to an expired session from the outside (a platform
    account's 401, by contrast, *does* set `sessionExpired` directly, since it's always the
    unambiguous plain-fetch path). A `DnrUnavailableError` also disables claude.ai's override
    mechanism for the rest of this service-worker's lifetime (a one-time capability probe —
    concurrent accounts in the very same batch may still race and both attempt it before either's
    failure is observed, but no new attempt happens after that). A transient (non-auth)
    `current_spend` failure for the active platform account comes back as `spendCents: null`
    (`fetchPlatformUsage`) — `preserveSpendOnNull()` keeps the *previous* `spendCents`/`spendResetsAt`
    in that case instead of overwriting a known value with `null`, so the next successful poll
    doesn't look like a brand-new baseline and re-fire every threshold. Without the optional platform
    host permission, the active platform account's fetch is skipped the same way (last known value
    kept, no error) — see `permissions.ts`; the per-service `getCurrentSessionCookie` calls above are
    each wrapped in `.catch(() => null)` so an unexpected failure reading one service's cookie can
    never abort the other service's refresh.
  - Every notification type lives behind `settings.notifications` (`claude` and `platform`
    substructures, each with its own `enabled` master switch plus per-type toggles) and fires exactly
    once per crossing/state change, since each is computed by comparing the account's fresh result
    against its own previous stored state (`notifyForUsageChange()`):
    - claude: `usageThresholds` (percent crossings, `thresholdCrossings()`, which notifies on a
      first-ever read that's already high), `limitReached` (`isLimitReached()` transitioning
      false→true), `autoSwitch` (fired from `runPollCycle()` right after a non-`confirm` rule
      switches), `sessionExpired` (transitioning false→true).
    - platform: `spendThresholdsCents` (absolute-cents crossings on the active account's
      `billing.spendCents`, via `rules.valueCrossings(..., { notifyOnUnknownPrev: false })` — unlike
      claude's percent thresholds, a first-ever read does **not** notify; it just establishes the
      baseline silently, since a brand-new account's "first" spend isn't a meaningful crossing). When
      `billing.spendResetsAt` differs between the previous and next read (a new monthly billing
      period started), the previous spend is treated as `0` for this comparison — otherwise a
      post-reset spend that's numerically lower than the old period's would look like "spend went
      down" and never re-cross thresholds that are, in the new period, freshly crossed. `apiDisabled`
      (`billing.apiDisabledReason` transitioning null→non-null — "out of credits"), `sessionExpired`.
    `Settings.notifyAtPercent` is deprecated (migrated into `notifications.claude.usageThresholds` by
    `storage.mergeSettings()` on load) but no longer read directly here.
  - `runPollCycle()` refreshes usage, then runs `evaluateRules()` (claude.ai-only, see `rules.ts`); a
    matching non-`confirm` rule switches immediately (and notifies per `notifications.claude.autoSwitch`
    above), a `confirm: true` rule instead shows a notification with "Switch now"/"Dismiss" buttons
    (the pending choice is stashed in `chrome.storage.session`, keyed by notification id). Clicking
    "Switch now" re-validates the target (it may have been removed/paused/expired since the
    notification was created) and never lets a failed switch escape as an unhandled rejection; a
    `chrome.notifications.onClosed` listener cleans up the pending entry if the notification is
    dismissed without a click, so a stray later event can't replay it.
  - The action badge (`updateBadge()`) is claude.ai-only: shows the active **claude.ai** account's
    `badgeMetric` as a rounded percent, colored green (<70%), amber (<90%), or red (≥90%), or cleared
    when `settings.showBadge` is off or there's no data yet (`serviceOf(a) === 'claude'` guards the
    account lookup even if `activeAccountId` were ever to reference something else). The `switch-next`
    keyboard command (declared in `public/manifest.json`) always targets claude.ai; the `switchNext`
    message takes an optional `service` and both resolve through `rules.nextEligibleAccount()` — a
    plain round-robin over that service's accounts only, independent of any rule.

- **`router.ts`** — the single `chrome.runtime.onMessage` listener, one case per `Request` in
  `src/shared/messages.ts`, replying with the `{ ok, data | error }` envelope and broadcasting a
  `stateChanged` event afterwards (best-effort — a `sendMessage` with no listener just rejects, which
  is ignored). Messages from any sender other than this extension (`sender.id !== chrome.runtime.id`)
  and unrecognized request types are rejected with `ok:false` and never broadcast.
  `toPublicState()` builds the secret-free `PublicState` the UI sees, including both services'
  active-account ids, `unsavedSessionDetected`/`unsavedPlatformSessionDetected` via
  `session.isSessionUnsaved()`, and `platformPermission` via `permissions.hasPlatformPermission()` —
  each of these three calls is wrapped in its own `.catch(() => false)` so an unexpected failure in
  any one of them (e.g. the permission check itself throwing) can never crash `getState` and take
  down the whole popup, which is exactly the production bug (`chrome.cookies.get` throwing for an
  ungranted optional permission) this isolation exists to prevent.
  `captureCurrentAccount`/`switchNext`/`addAccountFlow` pass
  their request's optional `service` straight through (default `'claude'`); `switchAccount` doesn't
  need one since it's inferred from the target account. A platform-targeted
  `captureCurrentAccount`/`addAccountFlow`/`switchAccount` without the optional host permission
  granted surfaces as an ordinary `{ ok: false, error: "Allow access to platform.claude.com first." }`
  response (see `session.ts`), same as any other rejected request — claude.ai requests are unaffected.
  `broadcastState()` is exported so `index.ts` can call it from the `chrome.permissions.onAdded`/
  `onRemoved` listeners below.
  `updateAccount`'s patch is whitelisted and type-checked at runtime to exactly
  `label`/`color`/`paused` (string/string/boolean) — the message type says the same thing, but a
  message arrives as plain JSON with no compile-time guarantee behind it.
  `removeAccount` also clears `activePlatformAccountId` if that was the removed account, drops the id
  from `settings.accountOrder`, and disables (not deletes) any rule whose `specific` target was that
  account, clearing their now-irrelevant `lastRuleFire` entries.
  `saveSettings` and `importData` both merge their settings patch through `storage.mergeSettings()`,
  which deep-merges `notifications.claude`/`notifications.platform` individually — a shallow
  `{...current, ...patch}` would let a patch containing only `{ notifications: { claude: {...} } }`
  silently wipe out the `platform` notification settings.
  `importData` also prunes any secret left pointing at an account that doesn't exist in the
  post-import account list (whether because the import replaced accounts with a smaller set, or a
  secret was already orphaned) and nulls out `activeAccountId`/`activePlatformAccountId` if either
  pointed at an account the import dropped — a stale id there would otherwise silently survive import
  and later break a switch or a usage refresh. The secret-merge-by-`accountId` behavior for an
  account that *does* survive the import is unchanged (import's value wins for that account).
  `exportData`/`importData` always include accounts/rules/settings/history in plain JSON; secrets are
  only ever included when `includeSecrets` **and** a `passphrase` are both given, encrypted with
  AES-GCM using a PBKDF2-derived (600,000 iterations, SHA-256; the iteration count is recorded in the
  blob so a future increase can't break importing an older export — anything missing it is assumed to
  be 100,000, the original value) key. Exporting secrets without a passphrase is refused outright.
  Importing fully decrypts and validates the payload **before** touching storage, then applies
  everything in one `updateState` call — a wrong passphrase or malformed export leaves existing state
  completely untouched instead of a half-applied import — and imported secrets are merged by
  `accountId` rather than replacing the whole list, so secrets for accounts the import doesn't
  mention (e.g. added locally after the export was taken) survive. A successful import reschedules
  polling and repaints the badge, same as `saveSettings`.

- **`index.ts`** — the bundle entry. Every module above registers its `chrome.*` listeners as a
  top-level, synchronous side effect of being imported (an MV3 requirement: listeners added inside
  an awaited callback can miss events that fire before they attach), so `index.ts` itself only needs
  plain static imports plus the one-time startup logic (schedule the poll alarm, paint the badge,
  sweep any leftover DNR override rule) — run both on `chrome.runtime.onInstalled` and once on every
  service-worker wake, since the latter can happen without the former.
  It also registers `chrome.permissions.onAdded`/`onRemoved` listeners (top-level, synchronous, same
  MV3 requirement) that check whether the changed permissions include the platform origin pattern:
  granting it triggers `scheduler.refreshUsage()` (so the newly-accessible platform account's spend
  shows up immediately rather than waiting for the next poll) followed by `router.broadcastState()`;
  revoking it only broadcasts, since there's nothing left to refresh. This lives in `index.ts` rather
  than `router.ts` because it needs both `router.ts`'s `broadcastState` and `scheduler.ts`'s
  `refreshUsage`, and only `index.ts` can see both without a circular import between them.

## Known limitations / unverified assumptions

- Multi-org accounts: `pickOrganization()` prefers the org matching claude.ai's `lastActiveOrg`
  cookie, then the first paid-looking org, then simply the first one — an account in several orgs is
  still only ever tracked under one of them at a time.
- The park/clear/restore sequence (`parkServiceTabs`/`clearServiceSiteStorage`/`sendParkedTabsTo` in
  `session.ts`) is implemented and unit-tested against the documented `chrome.tabs`/`chrome.browsingData`
  APIs, but **has not been live-verified against claude.ai's actual SPA behavior** (no interactive
  browser was available while building this fix) — i.e. it's confirmed to park tabs, swap the cookie,
  clear site data, and restore tabs in the right order, but not independently confirmed to actually
  prevent the involuntary-logout call that motivated it. `PARK_TIMEOUT_MS` (4 seconds) is a guess at
  a safe upper bound for a tab to finish loading the static switching page; a slower device/profile
  could in theory start the cookie swap before a tab has actually stopped running its old page.
- `fetchUsageWithSessionOverride` (declarativeNetRequest cookie trick) is implemented against the
  documented API and unit-tested. The mechanism itself was verified in Chromium against a local echo
  server: a session rule with `initiatorDomains: [runtime.id]` + `tabIds: [TAB_ID_NONE]` +
  `resourceTypes: ['xmlhttprequest']` does set the `Cookie` header on the service worker's
  `fetch(..., { credentials: 'omit' })`, and requests from tabs are left untouched. Whether claude.ai
  accepts a session presented this way is still to be confirmed live. It fails soft either way:
  a non-working override shows up as `Account.usageError` with the last known snapshot kept, not as a
  false "please log in again."
- The declarativeNetRequest capability probe (`dnrOverrideDisabled` in `scheduler.ts`) is an
  in-memory flag: it resets on every service-worker restart, so a browser where the mechanism never
  works will keep re-attempting it shortly after each restart rather than staying permanently
  disabled. Given how often MV3 service workers restart, this is an intentional, low-cost trade-off
  over persisting the flag to storage.
- Platform support's scope (account management only, no usage limits/rules/notifications beyond a
  single spend figure) was a deliberate product decision — not a technical limitation. If that scope ever widens (e.g. real spend
  *limits*, not just current spend), `PlatformBilling`/`UsageSnapshot.billing` and the
  `notifications.platform` toggles already exist as the extension points.
- Non-active platform accounts never get polled (no declarativeNetRequest override exists for
  platform — see `claudeApi.ts`'s platform section): their `usage`/`billing` is only ever as fresh as
  the last time they were the active platform account.
- claude.ai's and platform.claude.com's API shapes are unofficial and can change at any time; every
  parser here tolerates missing/renamed fields rather than throwing, except for the unambiguous "the
  session is dead" signal (401/403) on the active-account path.
- The platform `sessionKey` cookie's exact domain scope (host-only vs. `.claude.com`) is unverified —
  see the callout in "Two services" above.
