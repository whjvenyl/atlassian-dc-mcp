# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`atlassian-dc-mcp` — a Model Context Protocol server that fronts
self-hosted Atlassian Data Center instances (Confluence + Jira). Each
request carries the caller's own Personal Access Token; a server-side
`policy.yaml` caps which spaces/projects are reachable. On Atlassian
Cloud this problem doesn't exist (use the official Rovo MCP) — this repo
is DC/self-hosted only.

## Architecture in 60 seconds

```
client --(PAT in headers)--> index.ts (HTTP, /mcp)
                              ├─ auth.ts      extract credentials, precedence
                              ├─ client.ts    AtlassianClient (REST), resolveIdentity (cached)
                              ├─ policy.ts    policy.yaml → global cap ∩ user rules
                              ├─ audit.ts     JSON line per call on stderr
                              └─ tools/       confluence.ts, jira.ts (register on McpServer)
```

Per-request, stateless: a fresh `McpServer` + `StreamableHTTPServerTransport`
is built for every HTTP request (`sessionIdGenerator: undefined`) —
credentials never cross requests.

## Commands

```bash
npm ci            # install (dev deps needed for tsc/tsx)
npm run check     # typecheck (no emit)
npm test          # node:test suite via tsx — the security-critical coverage
npm run build     # tsc → dist/
npm run dev       # tsx watch
```

CI runs check + test + build + a config smoke test on every push/PR.

## Non-negotiables (security model)

- **Never store credentials.** PATs arrive per-request in headers and are
  used in-memory only. No caching of raw tokens anywhere — identity cache
  keys are SHA-256 hashes.
- **Policy only narrows, never widens.** `intersectCaps` is the heart of
  it: effective scope = PAT's DC permissions ∩ global cap ∩ user rules.
  A user rule can never add a space outside the global cap — tests cover
  this. Don't "helpfully" relax it.
- **Fail closed.** Unresolvable identity → defaults → global cap → deny.
  Empty intersection = deny all, not allow.
- **Denial errors carry data.** Never dead-end "denied/not found" text —
  include the allowed scope and the next-step tool (MCP best practice).
- **Don't bypass policy in tests.** Exercising denied paths in tests is
  required; granting them is not.
- **Tool names are snake_case**, descriptions tell the agent the workflow
  (list → search → fetch) and the policy model. If you add tools, update
  the server `instructions` in `index.ts` too.

## API references

- **Jira DC 11.x** (canonical): `developer.atlassian.com/server/jira/platform/rest/v11002/` — `/rest/api/2/*` + agile `/rest/agile/1.0/*` (board/sprint/epic/backlog). Machine-readable spec: `dac-static.atlassian.com/server/jira/platform/jira_software_dc_11002_swagger.v3.json` — every endpoint we call was audited against it (33/33 match) and against the DC 10.3 LTS spec (`…_dc_10003_swagger.v3.json`, also a full match; `createmeta` uses the path form on 10.x too).
- **Older Jira DC lines**: `docs.atlassian.com/software/jira/docs/api/REST/{version}/` — check here when supporting DC 8/9/10 instances; endpoint shapes differ (e.g. `createmeta` moved to the path form in DC 11 — `fields.ts` tries DC 11 first, legacy query form as fallback; `fieldsByKeys` is newer).
- **Confluence DC**: `developer.atlassian.com/server/confluence/rest/` — `/rest/api/*`.
- When behavior is version-sensitive, prefer gating at call time via `jira_server_info` / `confluence_server_info` over guessing.

## Conventions

- TypeScript ESM (`"type": "module"`), `Node16` module resolution,
  `.js` extensions on relative imports.
- `server.tool(name, description, zodSchema, handler)` — handlers return
  `{content:[{type:"text",text}]}`, `isError:true` for failures.
- Wrap handlers in `audited(toolName, getUsername, handler)` from
  `audit.ts` so every call logs.
- Logging: `console.error` only (stderr). Never `console.log`.
- Errors thrown from handlers surface as MCP tool errors — policy denials
  throw `Error("Policy denies …")`, client/API errors bubble from
  `client.ts`.

## Releases

Driven by release-please — use **conventional commits**
(`feat:`, `fix:`, `chore:`, `docs:`, `ci:`). A Release PR auto-bumps
`package.json` + `CHANGELOG.md`; merging it creates the tag + Release
and triggers `publish.yml` (npm via trusted publishing, binary matrix,
asset upload) + `docker.yml` (GHCR). Don't hand-edit version numbers or
tags.

## Secrets

`policy.yaml`, `.env*` and `*.pem` are gitignored — they belong to
deployments, not the repo. Never commit credentials; policy examples
go in `policy.example.yaml` with placeholder values.
