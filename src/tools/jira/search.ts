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

export function registerJiraSearchTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "jira_search",
    "Search Jira with JQL. Your query is AND-ed with the project allowlist from the server policy — you cannot widen it.",
    {
      jql: z
        .string()
        .describe("JQL, e.g. 'assignee = currentUser() AND status != Done'"),
      limit: z.number().int().min(1).max(100).default(20),
      startAt: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Pagination offset for follow-up calls"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated fields, or '*all'. Default summary,status,project,assignee,issuetype,updated"),
      expand: z
        .string()
        .optional()
        .describe("Comma-separated expands, e.g. 'renderedFields','names'"),
      projectsFilter: z
        .string()
        .optional()
        .describe("Comma-separated project keys — intersected with your policy scope"),
      useDisplayNames: z
        .boolean()
        .default(false)
        .describe("Add the 'names' map so customfield_* IDs resolve to labels"),
    },
    audited("jira_search", getUsername, async ({ jql, limit, startAt, fields, expand, projectsFilter, useDisplayNames }) => {
      const policy = getPolicy();
      let projects = effectiveProjects(policy, await getUsername());
      denyIfEmpty(projects, "jira_search");
      if (projectsFilter) {
        const wanted = projectsFilter.split(",").map((s) => s.trim()).filter(Boolean);
        projects = projects === undefined
          ? wanted
          : projects.filter((p) => wanted.includes(p));
        denyIfEmpty(projects, "jira_search");
      }
      const scoped =
        projects && projects.length > 0
          ? `(${jql}) AND project in (${projects.join(",")})`
          : jql;
      const expandParts = new Set(
        (expand ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      );
      if (useDisplayNames) expandParts.add("names");
      const res = (await client.get("/rest/api/2/search", {
        jql: scoped,
        maxResults: limit,
        startAt,
        fields:
          fields ??
          "summary,status,project,assignee,reporter,issuetype,updated",
        ...(expandParts.size ? { expand: [...expandParts].join(",") } : {}),
      })) as { issues?: Issue[]; total?: number; names?: Record<string, string> };
      const returned = res.issues?.length ?? 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: res.total,
                returned,
                startAt,
                nextStartAt: startAt + returned,
                effectiveJQL: scoped,
                ...(res.names ? { names: res.names } : {}),
                issues: (res.issues ?? []).map((i) => issueSummary(i, base)),
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
