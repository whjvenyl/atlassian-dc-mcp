# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-11-25

### Fixed

- `github-release` now runs when binaries succeed even if npm publish
  fails (e.g. EOTP from account-level 2FA) —
  `if: always() && needs.binaries.result == 'success'`.
- Release creation uses `softprops/action-gh-release` — purpose-built
  asset upload, no repo checkout needed.

### Changed

- README rewritten: persona-led setup (local / MCPHub team / shared
  endpoint), agent-setup prompt, mermaid diagrams, DC version + endpoint
  compatibility matrix.

### Removed

- `NPM_TOKEN` publish path — npm deprecated automation tokens and granular
  tokens fail with `EOTP` under publish-2FA. Trusted publishing (OIDC)
  is now the only npm path; `NPM_TRUSTED_PUBLISHING=true` enables it.

## [0.2.1] - 2026-11-25

### Fixed

- Dockerfile: `npm ci` ran `prepare` → `npm run build` before sources were
  copied — now `--ignore-scripts` + explicit build after `COPY src`.
- `github-release` job lacked `actions/checkout` → `gh release create`
  died with "not a git repository".
- `.dockerignore` keeps node_modules/dist/secrets out of the image context.

### Added

- Test suite (`node:test` + `tsx`, 29 tests): policy intersection semantics
  (can't-widen, deny-all, defaults fallback), credential precedence,
  audit logging, tool registration. Wired into CI.
- Rich `instructions` on server init: explains the scope model and the
  list → search → fetch workflow.
- Dependabot for npm, GitHub Actions, and Docker base images.

### Changed

- Policy-denied errors now include your allowed scope and actionable next
  steps instead of dead-end "denied" text (MCP best-practice: data over
  negative framing).
- Server instructions explicitly tell the agent not to retry-denied calls
  to work around the policy.

## [0.1.1] - 2026-11-25

### Added

- Standalone binaries on every release: `bun --compile` matrix for
  linux-x64, linux-arm64, darwin-arm64, darwin-x64, windows-x64 with
  `SHA256SUMS`, attached by a dedicated release job.
- `X-Atlassian-PAT` fallback header — one credential slot covers both
  products for one-PAT deployments (e.g. behind MCPHub).
- MCPHub deployment guide + `examples/mcphub-settings.json`.
- JSON audit line per tool call on stderr (`tool`, `user`, `denied`, `ms`).
- `server.json` (MCP Registry manifest) and `SECURITY.md`.

### Changed

- `npm publish` in `release.yml` is conditional: runs with `NPM_TOKEN`,
  via trusted publishing (`NPM_TRUSTED_PUBLISHING=true` repo variable),
  or skips with a notice — the GitHub Release and GHCR image proceed
  regardless.

## [0.1.0] - 2026-11-25

### Added

- Initial release: Streamable HTTP MCP server for self-hosted
  Confluence & Jira Data Center.
- Per-user PAT passthrough (`X-Confluence-PAT`, `X-Jira-PAT`,
  `Authorization`) — stateless, nothing stored server-side.
- `policy.yaml`: global caps on spaces/projects + per-user and defaults
  narrowing (intersection semantics, hot-reloaded, fail-closed).
- CQL/JQL scope injection on search + post-fetch space/project checks.
- Read tools + write-gated create tools (writes off by default).
- CI (typecheck/build/smoke), Docker image to GHCR, npm release pipeline
  with provenance.

[0.2.2]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/whjvenyl/atlassian-dc-mcp/releases/tag/v0.1.0
