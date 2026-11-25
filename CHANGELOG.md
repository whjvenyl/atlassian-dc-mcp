# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

CI/release-pipeline internals (workflows, npm publishing setup) are not
listed — this file tracks what changes for users and deployers of the
server.

## [0.2.2] - 2026-11-25

### Changed

- README rewritten: persona-led setup (local single-user / MCPHub team /
  shared endpoint), copy-paste prompt for agent-driven setup, mermaid
  diagrams, and a Data Center version + endpoint compatibility matrix.

## [0.2.1] - 2026-11-25

### Fixed

- Docker image build (npm `prepare` raced the source copy).

## [0.2.0] - 2026-11-25

### Added

- Test suite (`npm test`, `node:test`): policy intersection semantics
  (can't-widen, deny-all, defaults fallback), credential precedence,
  audit logging, tool registration — wired into CI.
- Rich `instructions` on server init: explains the scope model and the
  list → search → fetch workflow to connecting agents.
- Dependabot for npm, GitHub Actions, and Docker base images.

### Changed

- Policy-denied errors now include your allowed scope and actionable next
  steps instead of dead-end "denied" text (MCP best-practice: data over
  negative framing).
- Server instructions explicitly tell the agent not to retry-denied calls
  to work around the policy — it's enforced server-side.

## [0.1.1] - 2026-11-25

### Added

- Standalone binaries on every release: linux-x64, linux-arm64,
  darwin-arm64, darwin-x64, windows-x64 + `SHA256SUMS`.
- `X-Atlassian-PAT` fallback header — one credential covers both products
  for one-PAT deployments (e.g. behind MCPHub).
- MCPHub deployment guide + `examples/mcphub-settings.json`.
- JSON audit line per tool call on stderr (`tool`, `user`, `denied`,
  `ms`) — pipe it to your log collector.
- `server.json` (MCP Registry manifest) and `SECURITY.md`.

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
- Docker image, npm package, CI.

[0.2.2]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/whjvenyl/atlassian-dc-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/whjvenyl/atlassian-dc-mcp/releases/tag/v0.1.0
