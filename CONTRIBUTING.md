# Contributing to Switchboard for Claude

Thanks for your interest! This project is unofficial and community-maintained. By contributing, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) and license your work under the [MIT license](LICENSE).

## Ways to help

- **Report bugs** — use the [bug report template](../../issues/new?template=bug_report.yml). Include Chrome version, extension version, steps, and what you expected. **Never paste session keys, cookies, or exports** into issues.
- **Report claude.ai endpoint breakage** — usage numbers suddenly wrong or missing? Use the [endpoint-broke template](../../issues/new?template=endpoint_broke.yml); the unofficial usage API is the most likely thing to change under us.
- **Request features** — [feature request template](../../issues/new?template=feature_request.yml).
- **Send pull requests** — see below.

## Development setup

Requires **Node.js 22+**.

```sh
git clone https://github.com/dotKa/claude-switchboard.git
cd claude-switchboard
npm ci
npm run dev    # watch build into dist/
```

Load `dist/` at `chrome://extensions` → Developer mode → Load unpacked. Reload the extension card after changes.

## Before you open a PR

- `npm run typecheck`, `npm run test`, and `npm run build` must all pass.
- Add or update tests for behavior changes (`tests/`, Vitest).
- Keep changes focused; one concern per PR.
- English for code, comments, commit messages and docs.
- **Zero runtime dependencies** is a project goal — propose any new dev or runtime dependency in an issue first.
- No telemetry, tracking, or analytics code will ever be accepted.
- Do not use Anthropic logos, brand assets, or anything implying endorsement. The project must stay clearly unofficial.
- Privacy-sensitive code (anything touching `secrets` in storage, cookies, exports) gets extra review — see [SECURITY.md](SECURITY.md).

## Commit & PR style

- Conventional Commits: `feat(popup): ...`, `fix(rules): ...`, `docs: ...`, `chore(ci): ...`.
- Fill in the PR template; link the issue it closes.
- Bump `CHANGELOG.md` (Unreleased section) for user-visible changes — but leave version numbers and releases to maintainers.

## Release process (maintainers)

1. Update `CHANGELOG.md`, move Unreleased → the new version.
2. Bump `version` in both `package.json` and `public/manifest.json` (must match — CI enforces this via `scripts/check-version.mjs`).
3. Tag `vX.Y.Z`; the release workflow builds, verifies versions, and attaches `claude-switchboard.zip` to a GitHub Release.
