# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

CI/release-pipeline internals (workflows, npm publishing setup) are not
listed — this file tracks what changes for users and deployers of the
server.

## [0.3.0](https://github.com/whjvenyl/atlassian-dc-mcp/compare/atlassian-dc-mcp-v0.2.2...atlassian-dc-mcp-v0.3.0) (2026-11-25)


### Features

* 5 new jira tools — edit_comment, assign, assignable-users, worklogs (25 total) ([d956876](https://github.com/whjvenyl/atlassian-dc-mcp/commit/d956876989adc012230a1df962d0e23e0faea7bd))
* confluence comments parity + restrictions; split src + docs by domain (47 tools) ([543fd23](https://github.com/whjvenyl/atlassian-dc-mcp/commit/543fd234429eb49f8eeb98cfade638acbc12cdb2))
* confluence parity pass — 9 new tools + richer params (42 total) ([d4d82f0](https://github.com/whjvenyl/atlassian-dc-mcp/commit/d4d82f07b98f92d43a3250b6cd706119d10cf427))
* ENABLED_TOOLS allowlist + docs: per-category tool pages, troubleshooting ([e6addb2](https://github.com/whjvenyl/atlassian-dc-mcp/commit/e6addb2927f8b03e64fa1bf3e021fd9f915f5baf))
* expand to 20 tools + Blume docs site ([f370f54](https://github.com/whjvenyl/atlassian-dc-mcp/commit/f370f5435025209fe93b190087f7b7879d86e8ec))
* jira field discovery + richer jira_search (29 tools) ([4efd0b7](https://github.com/whjvenyl/atlassian-dc-mcp/commit/4efd0b730b33db6d73b68b42dabfc28d5e4fb1b2))
* richer jira_get_issue params + jira_search pagination ([3df3017](https://github.com/whjvenyl/atlassian-dc-mcp/commit/3df301785155260a54c8299602404a987b8c4662))
* TOOLSETS env — named tool groups intersecting ENABLED_TOOLS ([46e06b3](https://github.com/whjvenyl/atlassian-dc-mcp/commit/46e06b3a0cc084b49ea813babc58af5de0feaebc))

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
