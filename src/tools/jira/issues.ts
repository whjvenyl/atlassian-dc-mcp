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

export function registerJiraIssuesTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "jira_get_issue",
    "Fetch a Jira issue by key (e.g. SUP-123). Refused if its project is outside your policy scope. Request only the fields you need — '*all' pulls every field including custom ones (large).",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      fields: z
        .string()
        .optional()
        .describe(
          "Comma-separated fields, or '*all' for everything incl. custom fields. " +
            "Default: summary,description,status,project,assignee,reporter,issuetype,created,updated",
        ),
      expand: z
        .string()
        .optional()
        .describe(
          "Comma-separated expands: 'renderedFields' (HTML), 'transitions', 'changelog', 'names'",
        ),
      commentLimit: z
        .number()
        .int()
        .min(0)
        .max(100)
        .default(0)
        .describe("Comments to include (0 = none)"),
      properties: z
        .string()
        .optional()
        .describe("Comma-separated issue properties to return"),
      useDisplayNames: z
        .boolean()
        .default(false)
        .describe("Include the 'names' map so customfield_* IDs resolve to display names"),
      includeComments: z
        .boolean()
        .optional()
        .describe("Deprecated — use commentLimit (true ≈ commentLimit=50)"),
    },
    audited("jira_get_issue", getUsername, async ({ key, fields, expand, commentLimit, properties, useDisplayNames, includeComments }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const lim = commentLimit > 0 ? commentLimit : includeComments ? 50 : 0;
      const expandParts = new Set(
        (expand ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      );
      if (useDisplayNames) expandParts.add("names");
      const issue = (await client.get(`/rest/api/2/issue/${key}`, {
        fields:
          fields ??
          "summary,description,status,project,assignee,reporter,issuetype,created,updated",
        ...(expandParts.size ? { expand: [...expandParts].join(",") } : {}),
        ...(properties ? { properties } : {}),
      })) as Issue & {
        id?: string;
        names?: Record<string, string>;
        transitions?: { id: string; name: string; to?: { name?: string } }[];
        changelog?: {
          histories?: {
            created?: string;
            author?: { displayName?: string };
            items?: { field?: string; fromString?: string; toString?: string }[];
          }[];
        };
      };
      const proj = issue.fields?.project?.key;
      if (proj) assertProjectAllowed(projects, proj, "jira_get_issue");

      let comments: unknown;
      if (lim > 0) {
        const res = (await client.get(`/rest/api/2/issue/${key}/comment`, {
          maxResults: lim,
        })) as {
          comments?: {
            id: string;
            author?: { displayName?: string };
            created?: string;
            body?: string;
          }[];
        };
        comments = (res.comments ?? []).map((c) => ({
          id: c.id,
          author: c.author?.displayName,
          created: c.created,
          body: c.body,
        }));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key: issue.key,
                id: issue.id,
                browseUrl: `${base}/browse/${issue.key}`,
                fields: issue.fields ?? {},
                ...(issue.names ? { names: issue.names } : {}),
                ...(issue.transitions
                  ? {
                      transitions: issue.transitions.map((t) => ({
                        id: t.id,
                        name: t.name,
                        to: t.to?.name,
                      })),
                    }
                  : {}),
                ...(issue.changelog
                  ? {
                      changelog: (issue.changelog.histories ?? []).map((h) => ({
                        at: h.created,
                        by: h.author?.displayName,
                        changes: (h.items ?? []).map((i) => ({
                          field: i.field,
                          from: i.fromString,
                          to: i.toString,
                        })),
                      })),
                    }
                  : {}),
                ...(comments !== undefined ? { comments } : {}),
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
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
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

  server.tool(
    "jira_update_issue",
    "Update fields on a Jira issue (summary, description, assignee, labels, priority). Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      summary: z.string().optional(),
      description: z.string().optional(),
      assignee: z.string().optional().describe("Atlassian username to assign"),
      labels: z.array(z.string()).optional(),
      priority: z.string().optional().describe("e.g. High, Medium, Low"),
    },
    audited("jira_update_issue", getUsername, async ({ key, summary, description, assignee, labels, priority }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_update_issue");
        const fields: Record<string, unknown> = {};
        if (summary !== undefined) fields.summary = summary;
        if (description !== undefined) fields.description = description;
        if (assignee !== undefined) fields.assignee = { name: assignee };
        if (labels !== undefined) fields.labels = labels;
        if (priority !== undefined) fields.priority = { name: priority };
        if (Object.keys(fields).length === 0)
          throw new Error("nothing to update — pass at least one field");
        await client.put(`/rest/api/2/issue/${key}`, { fields });
        const updated = (await client.get(`/rest/api/2/issue/${key}`, {
          fields: "summary,status,project,assignee,issuetype,updated,priority,labels",
        })) as Issue;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ updated: key, ...issueSummary(updated, base) }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
          ],
        };
      }
    }),
  );

  server.tool(
    "jira_assign_issue",
    "Assign a Jira issue to a user (or unassign). Only when policy allows writes; the issue's project must be inside your scope. Pair with jira_search_assignable_users to find valid usernames.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      assignee: z
        .string()
        .nullable()
        .describe("Atlassian username, or null/empty to unassign"),
    },
    audited("jira_assign_issue", getUsername, async ({ key, assignee }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_assign_issue");
        await client.put(`/rest/api/2/issue/${key}/assignee`, {
          name: assignee || null,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { assigned: key, to: assignee || "(unassigned)" },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
          ],
        };
      }
    }),
  );

  server.tool(
    "jira_get_transitions",
    "List the workflow transitions available for an issue right now (names + IDs for jira_transition_issue).",
    { key: z.string().describe("Issue key, e.g. SUP-123") },
    audited("jira_get_transitions", getUsername, async ({ key }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const project = key.split("-")[0];
      assertProjectAllowed(projects, project, "jira_get_transitions");
      const res = (await client.get(`/rest/api/2/issue/${key}/transitions`)) as {
        transitions?: { id: string; name: string; to?: { name?: string } }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key,
                transitions: (res.transitions ?? []).map((t) => ({
                  id: t.id,
                  name: t.name,
                  to: t.to?.name,
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
    "jira_transition_issue",
    "Change an issue's status via its workflow (e.g. To Do → In Progress → Done). Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      transition: z.string().describe("Transition name or ID — call jira_get_transitions first to see valid options"),
      comment: z.string().optional().describe("Optional comment added with the transition"),
    },
    audited("jira_transition_issue", getUsername, async ({ key, transition, comment }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_transition_issue");
        // resolve name → id against the issue's real workflow
        const avail = (await client.get(`/rest/api/2/issue/${key}/transitions`)) as {
          transitions?: { id: string; name: string }[];
        };
        const t = (avail.transitions ?? []).find(
          (x) => x.id === transition || x.name.toLowerCase() === transition.toLowerCase(),
        );
        if (!t)
          throw new Error(
            `transition '${transition}' not available for ${key}. ` +
              `Available: ${(avail.transitions ?? []).map((x) => x.name).join(", ") || "none"}`,
          );
        await client.post(`/rest/api/2/issue/${key}/transitions`, {
          transition: { id: t.id },
          ...(comment
            ? { update: { comment: [{ add: { body: comment } }] } }
            : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ transitioned: key, to: t.name }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
          ],
        };
      }
    }),
  );
}
