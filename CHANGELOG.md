# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-12

### Added

- Initial public release.
- Save multiple claude.ai accounts and switch between them with one click or the Alt+Shift+N shortcut.
- Usage-limit tracking for session (5-hour), weekly, and per-model limits (whatever tiers claude.ai reports), with toolbar badge (configurable metric, incl. "highest limit") and threshold notifications.
- Auto-switch rules (usage threshold, hard limit reached, or daily schedule) with round-robin / lowest-usage / priority / specific targets, target ceilings, cooldowns, and optional confirmation.
- Add-account flow that keeps saved accounts intact while signing into a new one.
- Claude Platform (platform.claude.com) accounts: save and switch independently of claude.ai, with this month's spend shown when available (optional host permission, requested from the popup).
- Per-product notifications: claude.ai usage thresholds, limit reached, auto-switch, expired sessions; Claude Platform spend thresholds, API disabled, expired sessions.
- Safe switching: open tabs are parked while the session cookie is swapped and the site's cached account data is cleared, so the site never signs the new session out.
- Labels and colors for accounts; pause accounts to exclude them from auto-rotation.
- Passphrase-encrypted export/import of configuration and sessions.
- All data stored locally; no servers, no telemetry.

[Unreleased]: https://github.com/dotKa/claude-switchboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dotKa/claude-switchboard/releases/tag/v0.1.0
