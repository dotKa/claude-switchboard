# Privacy Policy — Switchboard for Claude

_Last updated: 2026-10-12 · Applies to version 0.1.0 and later until replaced._

Switchboard for Claude ("the extension") is an unofficial, open-source Chrome extension. It is designed to be **local-first**: it has no backend, no accounts of its own, and no analytics. This policy describes exactly what data the extension handles and where it goes.

## The short version

- Everything the extension stores stays **on your device** in `chrome.storage.local`.
- The only network requests the extension makes go to **claude.ai** and **platform.claude.com** (Anthropic's services), and only to do what the extension exists for: reading your usage and applying the session you chose.
- **No data is sent to the developers or to any third party. No telemetry, no crash reporting, no tracking, no ads.**
- We cannot access, recover, or reset anything for you — we never have your data in the first place.

## What the extension stores locally

| Data | Purpose |
|---|---|
| claude.ai / platform.claude.com `sessionKey` cookie for each account you save | Switching between your accounts |
| Account metadata (email, display name, organization, plan tier, your labels/colors/paused flag) | Displaying and organizing your accounts |
| Usage snapshots (percentage used and reset time for 5-hour/weekly windows) | Display, badge, notifications, auto-switch rules |
| Your rules and settings | Configuration |
| Switch history (last 200 events) | Display in the UI |

This data is stored only in Chrome's local extension storage on your device. It is **not** synced via Chrome sync and is never transmitted anywhere other than to claude.ai or platform.claude.com as part of normal operation (e.g. the `sessionKey` cookie is set on that site when you switch to that account — the same thing your browser does whenever you use that site).

## Network communication

The extension communicates exclusively with `https://claude.ai/*` and `https://platform.claude.com/*`:

- **Reading the `sessionKey` cookie** for claude.ai or platform.claude.com when you save or switch accounts (via the `cookies` permission).
- **Setting the `sessionKey` cookie** when you switch accounts.
- **Fetching usage information** from claude.ai's own usage endpoint (the same data its settings page shows) for your saved accounts.

The extension contains **no third-party SDKs, no analytics libraries, and no remote code**. All code runs from the packaged extension.

## Clearing stale account data on switch

When you switch accounts, the extension briefly parks any open claude.ai/platform.claude.com tabs on its own blank "switching…" page, then clears that site's local storage/IndexedDB/cache/service-workers (via the `browsingData` permission, scoped to that one origin) **without touching cookies**, before returning the tabs to a neutral page. This exists because claude.ai's own web app caches which account is logged in outside of cookies; left in place, it could otherwise detect the swapped session as an error and invalidate it server-side. No data from this process ever leaves your device — it is purely local cleanup.

## Export / import

You can export your configuration. Exports that include sessions are **encrypted locally with a passphrase you choose** before leaving the extension. An encrypted export is only as safe as where you store it and how strong the passphrase is — treat it like a password file.

## Data you share with Anthropic

Using claude.ai itself is governed by Anthropic's own [Privacy Policy](https://www.anthropic.com/legal/privacy). Switchboard does not add to, remove from, or intermediate that relationship; it merely manages which of your sessions your browser presents to claude.ai.

## Permissions and why they exist

See `docs/store-listing.md` for the full, per-permission justification that accompanies the Chrome Web Store listing. In short: `cookies` and `tabs` and the claude.ai host permission exist to perform the account switching; `storage` holds local state; `alarms` schedules usage polling; `notifications` delivers threshold alerts; `declarativeNetRequest` supports detecting claude.ai rate-limit responses; `browsingData` clears the outgoing account's cached site data (not cookies) on a switch, see above.

## Children's privacy

The extension is not directed at children and collects no data from anyone.

## Changes to this policy

Material changes are recorded in `CHANGELOG.md` and in this file's history in the public GitHub repository. Continued use after a change constitutes acceptance.

## Contact

Open an issue (no personal data, please) at <https://github.com/dotKa/claude-switchboard/issues>, or report security-sensitive matters privately per [SECURITY.md](SECURITY.md).
