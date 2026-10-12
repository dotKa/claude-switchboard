# Security Policy — Switchboard for Claude

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**, or
2. Use <https://github.com/dotKa/claude-switchboard/security/advisories/new>.

Include: affected version, steps to reproduce, impact, and any suggested fix. We aim to acknowledge reports within **72 hours** and to release a fix or mitigation within **30 days** for confirmed issues, coordinated with you on disclosure timing.

Suitable reports include anything that could let a website, another extension, or a local attacker read or steal stored `sessionKey` values, trigger unintended account switches, inject content into claude.ai or the extension UI, or exfiltrate any extension data.

## Scope & supported versions

Only the latest release is supported with security fixes. Pre-1.0, that's the newest `v0.x` tag.

## Threat model (summary)

**What must be protected.** Each saved account's claude.ai `sessionKey` is bearer credentials: whoever has it _is_ that account to claude.ai. It is the extension's crown jewel.

**Assets and handling:**

- Session keys are stored **only** in `chrome.storage.local` (never synced, never in `localStorage`, never in web-accessible resources, never in source or release artifacts).
- Exported data including sessions is encrypted locally with a user-supplied passphrase; unencrypted exports omit secrets by default.
- The extension UI receives a secret-free view of state from the background service worker; popup/options pages never handle session values.
- No network egress except to `claude.ai` itself. No third-party scripts, no remote code, no dynamic `eval`.
- Extension pages are protected by the MV3 default CSP; messages into the background are validated against the shared request/response contract (`src/shared/messages.ts`).

**Out of scope / your side of the street:**

- **Device compromise.** Malware with user-level access to your Chrome profile can read extension storage, as it can read any local browser data. Keep your OS and Chrome updated, use a locked screen, and consider OS account encryption.
- **Other extensions.** Any extension you install with broad permissions can read cookies and page content. Audit your installed extensions; remove ones you don't trust.
- **Anthropic's service.** Outages, endpoint changes, or compromise of claude.ai itself are Anthropic's domain. Session expiry/revocation is handled by claude.ai, not by us.
- **Phishing and exports.** If you send someone your export or your `sessionKey`, the extension can't help. Never share either.

**Design consequence:** an extension vulnerability that leaks `secrets` from `chrome.storage.local` is a *critical* bug here. Please err on the side of reporting.

## Hardening notes for contributors

- Never log, sync, or serialize `AccountSecret` values outside encrypted export.
- Keep the `secrets` storage key touched by background code only.
- Validate all incoming `runtime.onMessage` payloads against the shared contracts before acting.
- Do not add permissions without a justification in `docs/store-listing.md`.
