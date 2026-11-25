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
}
