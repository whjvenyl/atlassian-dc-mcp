# atlassian-dc-mcp

MCP server for **self-hosted Atlassian Data Center** — Confluence and Jira —
built for shared deployments where every user brings **their own PAT** and a
server-side **policy caps what each user (or everyone) can reach**.

> On **Atlassian Cloud**, use the official
> [Rovo MCP](https://github.com/atlassian/atlassian-mcp-server)
> (`https://mcp.atlassian.com/v2/mcp`) — OAuth 2.1, admin data policies,
> audit logging included. This project exists because the official server
> does not support Data Center / self-hosted instances, where auth is
> PAT-based and admins need the policy layer somewhere else — here, in the
> deployment itself.

```
┌─────────┐  X-Confluence-PAT / X-Jira-PAT   ┌──────────────────┐        ┌──────────────┐
│  user   │ ───────────────────────────────▶ │  atlassian-dc-mcp│ ─────▶ │ Confluence DC │
│ (agent) │                                  │  · policy check  │        └──────────────┘
└─────────┘                                  │  · CQL/JQL scope │ ─────▶ │   Jira DC     │
                                             └──────────────────┘        └──────────────┘
```

Effective access per request = **PAT's DC permissions ∩ global cap ∩
user rules**. Layers only ever narrow — a user's PAT can never reach
outside the server policy.

## Why not just point a generic MCP at DC?

- **PATs are per-user.** Confluence/Jira DC have no OAuth for PAT users; the
  PAT *is* the identity. This server takes each caller's PAT in request
  headers and never stores it — a shared instance stays credential-free.
- **The platform admin owns the ceiling.** `policy.yaml` sets a global cap
  (e.g. "nobody reaches spaces other than TEAM, DOC") that no client can
  override — including prompts injected via tool results.
- **Enforcement is server-side.** Searches get the allowlist AND-ed into
  their CQL/JQL; direct fetches are checked against the page/issue's space
  or project after fetch. Both layers fail closed.

## Quick start

```bash
npm install -g atlassian-dc-mcp        # or: npx atlassian-dc-mcp
export CONFLUENCE_BASE_URL=https://confluence.corp.example
export JIRA_BASE_URL=https://jira.corp.example
cp node_modules/atlassian-dc-mcp/policy.example.yaml policy.yaml
atlassian-dc-mcp                     # listens on :3000
```

Self-signed CA on your DC instances? Point Node at it before starting:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

## Connecting a client

Each user configures their own PAT — there is nothing to distribute:

```jsonc
{
  "mcpServers": {
    "confluence": {
      "type": "http",
      "url": "https://mcp.corp.example/mcp",
      "headers": {
        "X-Confluence-PAT": "<my confluence PAT>",
        "X-Jira-PAT": "<my jira PAT>"
      }
    }
  }
}
```

One PAT valid on both instances (e.g. shared SSO directory)? A single
`Authorization: Bearer <pat>` header covers both.

## Policy

`POLICY_PATH` (default `./policy.yaml`), hot-reloaded on change:

```yaml
global:
  confluence:
    allowedSpaces: ["TEAM", "DOC"]   # hard cap, applies to EVERYONE
    # readOnly: true               # kill confluence_* writes for all
  jira:
    allowedProjects: ["SUP", "PLAT"]
  allowWrites: false                 # writes globally off by default

defaults:                            # callers with no entry under users:
  confluence: { spaces: ["TEAM"] }
  jira:      { projects: ["SUP"] }

users:
  alice:                             # Atlassian username, resolved from
    confluence: { spaces: ["TEAM", "DOC"] }   # the caller's PAT — not
    jira:      { projects: ["SUP", "PLAT"] }  # from a spoofable header
```

Semantics:

- `allowedSpaces`/`allowedProjects` unset → no cap at that layer
- user/default lists are **intersected** with the global cap — a user rule
  naming a space outside the cap gets nothing
- intersection that matches nothing → deny all (fail closed)
- identity can't be resolved → `defaults` apply; no `defaults` → global cap only
- `allowWrites: false` or `readOnly` → write tools stay visible but refuse with an explanatory error

## Tools

| tool | enforcement |
|---|---|
| `confluence_search` | allowlist AND-ed into CQL |
| `confluence_get_page` | page's space checked post-fetch |
| `confluence_get_page_children` | children filtered by space |
| `confluence_list_spaces` | filtered to effective scope |
| `confluence_create_page` | write-gated + space checked |
| `jira_search` | allowlist AND-ed into JQL |
| `jira_get_issue` | issue's project checked post-fetch |
| `jira_list_projects` | filtered to effective scope |
| `jira_create_issue` | write-gated + project checked |

Every call emits one JSON audit line on stderr (`tool`, resolved
`user`, `denied`, `ms`) — pipe it to your log collector for the same
"who called what" visibility the official server's org audit log gives
Cloud deployments. Credentials are never logged.

## Deploying it shared

- Terminate TLS in front (it's an HTTP service — put it behind your
  ingress/reverse proxy). PATs transit in headers; **TLS is not optional**
  on a real deployment.
- `GET /healthz` for liveness.
- The server is stateless (no session affinity needed); scale it freely.
- Docker: `docker build -t atlassian-dc-mcp .` — image exposes :3000, runs
  non-root. Mount `policy.yaml` into `/app/`.

```bash
docker run -p 3000:3000 \
  -e CONFLUENCE_BASE_URL=https://confluence.corp.example \
  -e JIRA_BASE_URL=https://jira.corp.example \
  -v "$PWD/policy.yaml:/app/policy.yaml:ro" \
  -v "$PWD/corp-ca.pem:/etc/ssl/corp-ca.pem:ro" \
  -e NODE_EXTRA_CA_CERTS=/etc/ssl/corp-ca.pem \
  ghcr.io/<owner>/atlassian-dc-mcp:latest
```

## Configuration

| env | default | meaning |
|---|---|---|
| `CONFLUENCE_BASE_URL` | — | e.g. `https://confluence.corp.example` |
| `JIRA_BASE_URL` | — | e.g. `https://jira.corp.example` (at least one URL required) |
| `PORT` | `3000` | listen port |
| `POLICY_PATH` | `./policy.yaml` | policy file, hot-reloaded |
| `NODE_EXTRA_CA_CERTS` | — | extra CA bundle for self-signed DC certs |

## Releasing

CI runs typecheck + build + a config smoke test on every push/PR.
Pushing a `v*` tag runs `.github/workflows/release.yml`: version is checked
against `package.json`, the package is published to npm with a provenance
attestation, a GitHub release is created, and the Docker workflow pushes
`ghcr.io/<owner>/atlassian-dc-mcp:<version>`.

```bash
npm version patch      # or minor / major — bumps version, tags
git push --follow-tags
```

**One-time setup:** add a repo secret `NPM_TOKEN` (npm granular access
token, publish scope on `atlassian-dc-mcp`). After the first release exists
on npm you can drop the token entirely: configure *trusted publishing* on
npmjs.com for this repo + `release.yml`, then OIDC alone authenticates
publishes.

## Security model, in one breath

- Server holds **zero** secrets — every request carries its own PAT.
- DC still enforces the PAT's real permissions; policy only subtracts.
- Policy reload is atomic per request; malformed YAML keeps the last good policy.
- `policy.yaml` is gitignored — it belongs to the deployment, not the repo.
