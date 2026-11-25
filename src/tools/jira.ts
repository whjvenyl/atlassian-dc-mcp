import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../client.js";
import { audited } from "../audit.js";
import {
  effectiveProjects,
  jiraReadOnly,
  type Policy,
} from "../policy.js";

/**
 * Jira DC REST API reference: /rest/api/2/*
 * Enforcement model:
 *   - search: policy project list is AND-ed into the caller's JQL
 *   - get/create: the issue's project is checked against the effective list
 *   - effective list undefined => unrestricted; [] => deny all
 */

type Issue = {
  key: string;
  id?: string;
  fields?: {
    summary?: string;
    project?: { key?: string; name?: string };
    status?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    created?: string;
    updated?: string;
    description?: string;
  };
};

function issueSummary(i: Issue): Record<string, unknown> {
  return {
    key: i.key,
    summary: i.fields?.summary,
    project: i.fields?.project?.key,
    status: i.fields?.status?.name,
    type: i.fields?.issuetype?.name,
    assignee: i.fields?.assignee?.displayName ?? null,
    reporter: i.fields?.reporter?.displayName ?? null,
    updated: i.fields?.updated,
  };
}

function assertProjectAllowed(
  allowed: string[] | undefined,
  project: string,
  ctx: string,
) {
  if (allowed !== undefined && !allowed.includes(project)) {
    throw new Error(
      allowed.length === 0
        ? `Policy denies access to all Jira projects (${ctx}).`
        : `Policy denies access to project '${project}' (${ctx}). ` +
            `Your allowed projects: ${allowed.join(", ")}. ` +
            `Issues in those projects remain reachable via jira_get_issue/jira_search.`,
    );
  }
}

export function registerJiraTools(
  server: McpServer,
  client: AtlassianClient,
  _base: string,
  getPolicy: () => Policy,
  getUsername: () => Promise<string | null>,
): void {
  const denyIfEmpty = (projects: string[] | undefined, tool: string) => {
    if (projects && projects.length === 0)
      throw new Error(
        `Policy denies ${tool}: your effective Jira scope is empty ` +
          `(global cap ∩ your rules = nothing). Options: call ` +
          `jira_list_projects to confirm, ask the deployment admin to ` +
          `widen policy.yaml for your user, or use a PAT for a different ` +
          `account. Retrying with different queries will not bypass this.`,
      );
  };

  server.tool(
    "jira_search",
    "Search Jira with JQL. Your query is AND-ed with the project allowlist from the server policy — you cannot widen it.",
    {
      jql: z
        .string()
        .describe("JQL, e.g. 'assignee = currentUser() AND status != Done'"),
      limit: z.number().int().min(1).max(100).default(20),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated fields, default summary,status,project,assignee,issuetype,updated"),
    },
    audited("jira_search", getUsername, async ({ jql, limit, fields }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      denyIfEmpty(projects, "jira_search");
      const scoped =
        projects && projects.length > 0
          ? `(${jql}) AND project in (${projects.join(",")})`
          : jql;
      const res = (await client.get("/rest/api/2/search", {
        jql: scoped,
        maxResults: limit,
        fields:
          fields ??
          "summary,status,project,assignee,reporter,issuetype,updated",
      })) as { issues?: Issue[]; total?: number };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: res.total,
                returned: res.issues?.length ?? 0,
                effectiveJQL: scoped,
                issues: (res.issues ?? []).map(issueSummary),
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
    "jira_get_issue",
    "Fetch a Jira issue by key (e.g. SUP-123), including description and optionally comments. Refused if its project is outside your policy scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      includeComments: z.boolean().default(false),
    },
    audited("jira_get_issue", getUsername, async ({ key, includeComments }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const issue = (await client.get(`/rest/api/2/issue/${key}`, {
        fields:
          "summary,description,status,project,assignee,reporter,issuetype,created,updated" +
          (includeComments ? ",comment" : ""),
      })) as Issue & {
        fields?: {
          comment?: {
            comments?: {
              author?: { displayName?: string };
              created?: string;
              body?: string;
            }[];
          };
        };
      };
      const proj = issue.fields?.project?.key;
      if (proj) assertProjectAllowed(projects, proj, "jira_get_issue");
      const comments = (
        issue.fields as {
          comment?: {
            comments?: {
              author?: { displayName?: string };
              created?: string;
              body?: string;
            }[];
          };
        }
      )?.comment?.comments;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...issueSummary(issue),
                created: issue.fields?.created,
                description: issue.fields?.description,
                ...(comments
                  ? {
                      comments: comments.map((c) => ({
                        author: c.author?.displayName,
                        created: c.created,
                        body: c.body,
                      })),
                    }
                  : {}),
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
    "jira_create_issue",
    "Create a Jira issue. Only registered when policy allows writes; the target project must be inside your policy scope.",
    {
      project: z.string().describe("Project key"),
      issueType: z.string().describe("e.g. Task, Bug, Story"),
      summary: z.string(),
      description: z.string().optional(),
    },
    audited("jira_create_issue", getUsername, async ({ project, issueType, summary, description }) => {
      const policy = getPolicy();
      if (jiraReadOnly(policy)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Writes are disabled by server policy (global.allowWrites=false or jira.readOnly=true).",
            },
          ],
        };
      }
      const projects = effectiveProjects(policy, await getUsername());
      try {
        assertProjectAllowed(projects, project, "jira_create_issue");
        const created = (await client.post("/rest/api/2/issue", {
          fields: {
            project: { key: project },
            issuetype: { name: issueType },
            summary,
            ...(description ? { description } : {}),
          },
        })) as { key?: string; id?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(created, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: e instanceof Error ? e.message : String(e),
            },
          ],
        };
      }
    }),
  );
}
