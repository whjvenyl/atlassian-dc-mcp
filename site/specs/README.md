# Vendored OpenAPI specs

Served as the site's **API reference** (`/api/jira`, `/api/confluence`)
via Blume's `openapi()` adapter. Downloaded from Atlassian's
`dac-static.atlassian.com` CDN — update by replacing the file and
bumping the version in the name + `blume.config.ts` label.

| file | product / line | source |
|---|---|---|
| `jira-dc-11.2.json` | Jira Software DC 11.2 (288 paths, incl. `/rest/agile/1.0`) | `…/server/jira/platform/jira_software_dc_11002_swagger.v3.json` |
| `confluence-dc-9.2.json` | Confluence DC 9.2 (106 paths) | `…/server/confluence/9.2.2.swagger.v3.json` |

Older Jira LTS spec: `…_dc_10003_swagger.v3.json` (10.3). There is no
published Confluence spec before 9.x.

`overlays/` holds our doc-time fixes (applied per source, never editing
the spec itself):

- `jira.yaml` — `localhost:8090` server default → `jira.example.com`
  template; adds the `personalAccessToken` bearer scheme and retargets
  the 246 ops whose `security` required the spec's undefined `OAuth2`
  scheme (upstream defect).
- `confluence.yaml` — adds `personalAccessToken` beside `basic` so the
  Try it panel accepts PATs.

Known benign warnings: duplicate `operationId`s in the Jira spec
(Blume suffixes them) and 2 unused path params (upstream typos).
