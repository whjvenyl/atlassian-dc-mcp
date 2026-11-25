import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { audited } from "../../audit.js";
import { effectiveProjects } from "../../policy.js";
import {
  assertProjectAllowed,
  denyIfEmpty,
  issueSummary,
  makeWriteGuard,
  type Issue,
  type JiraCtx,
} from "../jira-common.js";

export function registerJiraMetaTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "jira_server_info",
    "Jira instance version, build and base URL — check this before relying on version-specific REST behavior (e.g. createmeta shape differs between DC releases). Unscoped: instance metadata, no project cap.",
    {},
    audited("jira_server_info", getUsername, async () => {
      const res = (await client.get("/rest/api/2/serverInfo")) as {
        baseUrl?: string;
        version?: string;
        versionNumbers?: number[];
        buildNumber?: number;
        deploymentType?: string;
        serverTime?: string;
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                baseUrl: res.baseUrl ?? base,
                version: res.version,
                versionNumbers: res.versionNumbers,
                buildNumber: res.buildNumber,
                deploymentType: res.deploymentType,
                restApi: "/rest/api/2",
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  server.tool(
    "jira_list_projects",
    "List Jira projects visible under the server policy (global cap ∩ your rules ∩ your PAT's DC permissions).",
    {},
    audited("jira_list_projects", getUsername, async () => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      denyIfEmpty(projects, "jira_list_projects");
      const res = (await client.get("/rest/api/2/project")) as {
        key: string;
        name: string;
        id: string;
      }[];
      const filtered = (res ?? []).filter(
        (p) => projects === undefined || projects.includes(p.key),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                policyProjects: projects ?? "unrestricted",
                count: filtered.length,
                projects: filtered.map((p) => ({
                  key: p.key,
                  name: p.name,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  server.tool(
    "jira_myself",
    "Return the Atlassian identity your PAT resolves to on Jira — the same identity per-user policy rules key on.",
    {},
    audited("jira_myself", getUsername, async () => {
      const me = (await client.get("/rest/api/2/myself")) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                name: me.name,
                key: me.key,
                displayName: me.displayName,
                emailAddress: me.emailAddress,
                active: me.active,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  server.tool(
    "jira_search_assignable_users",
    "Find users who can be assigned issues in a project or issue — use before jira_assign_issue/jira_update_issue's assignee. The project/issue must be inside your scope.",
    {
      query: z.string().describe("Name, username or email substring"),
      project: z.string().optional().describe("Project key to scope the search"),
      key: z.string().optional().describe("Issue key to scope the search"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    audited("jira_search_assignable_users", getUsername, async ({ query, project, key, limit }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const proj = project ?? key?.split("-")[0];
      if (!proj)
        throw new Error("pass project or key to scope the assignable-user search");
      assertProjectAllowed(projects, proj, "jira_search_assignable_users");
      const res = (await client.get("/rest/api/2/user/assignable/search", {
        username: query,
        ...(project ? { project } : {}),
        ...(key ? { issueKey: key } : {}),
        maxResults: limit,
      })) as {
        name?: string;
        key?: string;
        displayName?: string;
        emailAddress?: string;
        active?: boolean;
      }[];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: res?.length ?? 0,
                users: (res ?? []).map((u) => ({
                  name: u.name,
                  displayName: u.displayName,
                  emailAddress: u.emailAddress,
                  active: u.active,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // ── saved filters ────────────────────────────────────────────────────

  server.tool(
    "jira_search_filters",
    "Search saved Jira filters — a filter is a named JQL query teams organize around.",
    {
      filterName: z.string().optional().describe("Name contains"),
      limit: z.number().int().min(1).max(100).default(25),
      startAt: z.number().int().min(0).default(0),
    },
    audited(
      "jira_search_filters",
      getUsername,
      async ({ filterName, limit, startAt }) => {
        const res = (await client.get("/rest/api/2/filter/search", {
          ...(filterName ? { filterName } : {}),
          maxResults: limit,
          startAt,
          expand: "jql,favourite",
        })) as {
          values?: {
            id?: string; name?: string; jql?: string;
            favourite?: boolean; owner?: { displayName?: string };
          }[];
        };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filters: (res.values ?? []).map((f) => ({
                id: f.id, name: f.name, jql: f.jql,
                favourite: f.favourite, owner: f.owner?.displayName,
              })),
            }, null, 2),
          }],
        };
      },
    ),
  );

  server.tool(
    "jira_get_filter",
    "One saved filter by ID — name, owner, and its JQL. Run the JQL through jira_search for scoped results.",
    { filterId: z.string().describe("Filter ID — see jira_search_filters") },
    audited("jira_get_filter", getUsername, async ({ filterId }) => {
      const f = (await client.get(`/rest/api/2/filter/${filterId}`)) as {
        id?: string; name?: string; jql?: string;
        favourite?: boolean; owner?: { displayName?: string };
        sharePermissions?: unknown[];
      };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: f.id, name: f.name, jql: f.jql,
            favourite: f.favourite, owner: f.owner?.displayName,
            shared: (f.sharePermissions ?? []).length > 0,
          }, null, 2),
        }],
      };
    }),
  );

  // ── lookup metadata ──────────────────────────────────────────────────

  server.tool(
    "jira_list_priorities",
    "All priorities defined on the instance — the values a create/update 'priority' field accepts.",
    {},
    audited("jira_list_priorities", getUsername, async () => {
      const res = (await client.get("/rest/api/2/priority")) as {
        id?: string; name?: string; description?: string;
      }[];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            priorities: (res ?? []).map((p) => ({
              id: p.id, name: p.name, description: p.description,
            })),
          }, null, 2),
        }],
      };
    }),
  );

  server.tool(
    "jira_list_resolutions",
    "All resolutions (Fixed, Won't Do, Duplicate…) — the values a transition's 'resolution' field accepts.",
    {},
    audited("jira_list_resolutions", getUsername, async () => {
      const res = (await client.get("/rest/api/2/resolution")) as {
        id?: string; name?: string; description?: string;
      }[];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            resolutions: (res ?? []).map((r) => ({
              id: r.id, name: r.name, description: r.description,
            })),
          }, null, 2),
        }],
      };
    }),
  );

  server.tool(
    "jira_list_statuses",
    "All workflow statuses on the instance (name → statusCategory). Useful for reading an issue's status meaning.",
    {},
    audited("jira_list_statuses", getUsername, async () => {
      const res = (await client.get("/rest/api/2/status")) as {
        id?: string; name?: string;
        statusCategory?: { key?: string; name?: string };
      }[];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            statuses: (res ?? []).map((s) => ({
              id: s.id, name: s.name, category: s.statusCategory?.name,
            })),
          }, null, 2),
        }],
      };
    }),
  );

  server.tool(
    "jira_get_link_types",
    "Issue-link types defined on the instance — inward/outward labels to pass to jira_create_issue_link.",
    {},
    audited("jira_get_link_types", getUsername, async () => {
      const res = (await client.get("/rest/api/2/issueLinkType")) as {
        issueLinkTypes?: {
          id?: string; name?: string; inward?: string; outward?: string;
        }[];
      };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            linkTypes: (res.issueLinkTypes ?? []).map((t) => ({
              id: t.id, name: t.name, inward: t.inward, outward: t.outward,
            })),
          }, null, 2),
        }],
      };
    }),
  );

  server.tool(
    "jira_search_users",
    "Find any Jira user by name/email fragment — for mentions, watcher adds, or profile lookup when 'assignable' doesn't apply.",
    {
      query: z.string().describe("Name, email or username fragment"),
      limit: z.number().int().min(1).max(100).default(20),
      startAt: z.number().int().min(0).default(0),
    },
    audited(
      "jira_search_users",
      getUsername,
      async ({ query, limit, startAt }) => {
        const res = (await client.get("/rest/api/2/user/search", {
          query, maxResults: limit, startAt,
        })) as {
          name?: string; key?: string; displayName?: string;
          emailAddress?: string; active?: boolean;
        }[];
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              users: (res ?? []).map((u) => ({
                name: u.name, key: u.key, displayName: u.displayName,
                emailAddress: u.emailAddress, active: u.active,
              })),
            }, null, 2),
          }],
        };
      },
    ),
  );
}
