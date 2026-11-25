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

function issueSummary(i: Issue, base: string): Record<string, unknown> {
  return {
    key: i.key,
    url: `${base}/browse/${i.key}`,
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
  base: string,
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

  // ── write tools (gated by global.allowWrites + scope checks) ──

  const writeGuard = (): { isError: true; content: { type: "text"; text: string }[] } | null => {
    if (jiraReadOnly(getPolicy())) {
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
    return null;
  };

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
    "jira_add_comment",
    "Add a comment to a Jira issue. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      body: z.string().describe("Comment text (plain)"),
      visibility: z
        .string()
        .optional()
        .describe('Optional visibility, e.g. {"type":"group","value":"jira-users"}'),
    },
    audited("jira_add_comment", getUsername, async ({ key, body, visibility }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_add_comment");
        const created = (await client.post(`/rest/api/2/issue/${key}/comment`, {
          body,
          ...(visibility ? { visibility: JSON.parse(visibility) } : {}),
        })) as { id?: string; author?: { displayName?: string } };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { commented: key, id: created.id, author: created.author?.displayName },
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
    "jira_edit_comment",
    "Edit an existing comment on a Jira issue. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      commentId: z.string().describe("Comment ID — see jira_get_comments"),
      body: z.string().describe("New comment text"),
      visibility: z
        .string()
        .optional()
        .describe('Optional visibility, e.g. {"type":"group","value":"jira-users"}'),
    },
    audited("jira_edit_comment", getUsername, async ({ key, commentId, body, visibility }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_edit_comment");
        const payload: Record<string, unknown> = { body };
        if (visibility) payload.visibility = JSON.parse(visibility);
        await client.put(`/rest/api/2/issue/${key}/comment/${commentId}`, payload);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ edited: commentId, issue: key }, null, 2) },
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

  server.tool(
    "jira_get_worklogs",
    "List worklog entries on a Jira issue (author, time spent, started). Refused if the issue's project is outside your policy scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    audited("jira_get_worklogs", getUsername, async ({ key, limit }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const project = key.split("-")[0];
      assertProjectAllowed(projects, project, "jira_get_worklogs");
      const res = (await client.get(`/rest/api/2/issue/${key}/worklog`, {
        maxResults: limit,
      })) as {
        worklogs?: {
          id: string;
          author?: { displayName?: string; name?: string };
          timeSpent?: string;
          timeSpentSeconds?: number;
          started?: string;
          comment?: string;
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key,
                count: res.worklogs?.length ?? 0,
                worklogs: (res.worklogs ?? []).map((w) => ({
                  id: w.id,
                  author: w.author?.displayName ?? w.author?.name,
                  timeSpent: w.timeSpent,
                  started: w.started,
                  comment: w.comment,
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
    "jira_add_worklog",
    "Log time on a Jira issue. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      timeSpent: z
        .string()
        .describe("Jira format: '1h 30m', '1d', '30m', '4h'"),
      comment: z.string().optional().describe("Worklog comment"),
      started: z
        .string()
        .optional()
        .describe("ISO start time, e.g. '2026-11-25T12:00:00.000+0000' — default now"),
      remainingEstimate: z
        .string()
        .optional()
        .describe("New remaining estimate, e.g. '2h'"),
      originalEstimate: z
        .string()
        .optional()
        .describe("New original estimate, e.g. '1d'"),
    },
    audited("jira_add_worklog", getUsername, async ({ key, timeSpent, comment, started, remainingEstimate, originalEstimate }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_add_worklog");
        const created = (await client.post(`/rest/api/2/issue/${key}/worklog`, {
          timeSpent,
          ...(comment ? { comment } : {}),
          ...(started ? { started } : {}),
          ...(remainingEstimate
            ? { remainingEstimate }
            : {}),
          ...(originalEstimate
            ? { originalEstimate }
            : {}),
        })) as { id?: string; timeSpent?: string; author?: { displayName?: string } };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { logged: key, id: created.id, timeSpent: created.timeSpent, author: created.author?.displayName },
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
    "jira_get_issue_watchers",
    "List watchers on a Jira issue. Refused if the issue's project is outside your policy scope.",
    { key: z.string().describe("Issue key, e.g. SUP-123") },
    audited("jira_get_issue_watchers", getUsername, async ({ key }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const project = key.split("-")[0];
      assertProjectAllowed(projects, project, "jira_get_issue_watchers");
      const res = (await client.get(`/rest/api/2/issue/${key}/watchers`)) as {
        watchCount?: number;
        watchers?: { name?: string; displayName?: string; active?: boolean }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key,
                watchCount: res.watchCount ?? res.watchers?.length ?? 0,
                watchers: (res.watchers ?? []).map((w) => ({
                  name: w.name,
                  displayName: w.displayName,
                  active: w.active,
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
    "jira_add_issue_watcher",
    "Add a user as watcher on a Jira issue. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      username: z.string().describe("Atlassian username to add (DC uses usernames)"),
    },
    audited("jira_add_issue_watcher", getUsername, async ({ key, username }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_add_issue_watcher");
        // DC expects the username as a raw JSON string body
        await client.post(`/rest/api/2/issue/${key}/watchers`, username);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ watching: key, user: username }, null, 2),
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
    "jira_remove_issue_watcher",
    "Remove a watcher from a Jira issue. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      username: z.string().describe("Atlassian username to remove"),
    },
    audited("jira_remove_issue_watcher", getUsername, async ({ key, username }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        const project = key.split("-")[0];
        assertProjectAllowed(projects, project, "jira_remove_issue_watcher");
        await client.delete(`/rest/api/2/issue/${key}/watchers`, { username });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ unwatched: key, user: username }, null, 2),
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
    "jira_get_user_profile",
    "Look up a Jira user's profile by username — display name, email, groups. DC resolves by username.",
    {
      username: z.string().describe("Atlassian username, e.g. 'alice' — see jira_search_assignable_users"),
    },
    audited("jira_get_user_profile", getUsername, async ({ username }) => {
      const me = (await client.get("/rest/api/2/user", { username })) as Record<string, unknown>;
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
                timeZone: me.timeZone,
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
    "jira_get_comments",
    "List comments on a Jira issue (author, date, body). Refused if the issue's project is outside your policy scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    audited("jira_get_comments", getUsername, async ({ key, limit }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const project = key.split("-")[0];
      assertProjectAllowed(projects, project, "jira_get_comments");
      const res = (await client.get(`/rest/api/2/issue/${key}/comment`, {
        maxResults: limit,
      })) as {
        comments?: {
          id: string;
          author?: { displayName?: string };
          created?: string;
          body?: string;
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key,
                count: res.comments?.length ?? 0,
                comments: (res.comments ?? []).map((c) => ({
                  id: c.id,
                  author: c.author?.displayName,
                  created: c.created,
                  body: c.body,
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
    "jira_get_changelog",
    "Show an issue's field-change history (status transitions, edits) — who changed what and when.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    audited("jira_get_changelog", getUsername, async ({ key, limit }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const project = key.split("-")[0];
      assertProjectAllowed(projects, project, "jira_get_changelog");
      const res = (await client.get(`/rest/api/2/issue/${key}`, {
        expand: "changelog",
        fields: "summary",
        maxResults: limit,
      })) as {
        changelog?: {
          histories?: {
            id: string;
            created?: string;
            author?: { displayName?: string };
            items?: { field?: string; fromString?: string; toString?: string }[];
          }[];
        };
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key,
                history: (res.changelog?.histories ?? []).map((h) => ({
                  at: h.created,
                  by: h.author?.displayName,
                  changes: (h.items ?? []).map((i) => ({
                    field: i.field,
                    from: i.fromString,
                    to: i.toString,
                  })),
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

  // ── field discovery (createmeta-backed; helps agents write issues) ──

  server.tool(
    "jira_search_fields",
    "Search Jira field definitions by keyword (fuzzy, incl. custom fields) — find the customfield_* ID before updating or creating issues.",
    {
      query: z
        .string()
        .optional()
        .describe("Keyword for fuzzy match on field name; empty = first `limit` fields"),
      limit: z.number().int().min(1).max(200).default(20),
    },
    audited("jira_search_fields", getUsername, async ({ query, limit }) => {
      const res = (await client.get("/rest/api/2/field")) as {
        id: string;
        name: string;
        custom?: boolean;
        clauseNames?: string[];
        schema?: { type?: string };
      }[];
      const q = (query ?? "").toLowerCase();
      const matches = (res ?? [])
        .filter(
          (f) =>
            !q ||
            f.name.toLowerCase().includes(q) ||
            (f.clauseNames ?? []).some((c) => c.toLowerCase().includes(q)),
        )
        .slice(0, limit);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: matches.length,
                fields: matches.map((f) => ({
                  id: f.id,
                  name: f.name,
                  custom: f.custom ?? false,
                  type: f.schema?.type,
                  clauseNames: f.clauseNames,
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
    "jira_get_project_issue_types",
    "List the issue types available in a project (Task, Bug, Story…) — needed before jira_get_create_fields or jira_create_issue.",
    { project: z.string().describe("Project key") },
    audited("jira_get_project_issue_types", getUsername, async ({ project }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      assertProjectAllowed(projects, project, "jira_get_project_issue_types");
      const res = (await client.get(`/rest/api/2/project/${project}`)) as {
        issueTypes?: {
          id: string;
          name: string;
          description?: string;
          subtask?: boolean;
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project,
                issueTypes: (res.issueTypes ?? []).map((t) => ({
                  id: t.id,
                  name: t.name,
                  subtask: t.subtask ?? false,
                  description: t.description,
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

  const getCreateMeta = async (
    project: string,
    issueType: string,
    ctx: string,
  ) => {
    const res = (await client.get("/rest/api/2/issue/createmeta", {
      projectKeys: project,
      expand: "projects.issuetypes.fields",
    })) as {
      projects?: {
        issuetypes?: {
          id: string;
          name: string;
          fields?: Record<
            string,
            {
              name?: string;
              required?: boolean;
              schema?: { type?: string; custom?: string };
              allowedValues?: { id?: string; value?: string; name?: string }[];
            }
          >;
        }[];
      }[];
    };
    const its = res.projects?.[0]?.issuetypes ?? [];
    const it = its.find(
      (t) => t.id === issueType || t.name.toLowerCase() === issueType.toLowerCase(),
    );
    if (!it)
      throw new Error(
        `issue type '${issueType}' not found in ${project}. ` +
          `Available: ${its.map((t) => t.name).join(", ") || "none"} (${ctx})`,
      );
    return it;
  };

  server.tool(
    "jira_get_create_fields",
    "List the fields a create call accepts for a project + issue type — required flags, types, and option counts. Scope-checked against your policy.",
    {
      project: z.string().describe("Project key"),
      issueType: z.string().describe("Issue type name or ID, e.g. 'Bug' or '10002' — see jira_get_project_issue_types"),
    },
    audited("jira_get_create_fields", getUsername, async ({ project, issueType }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      assertProjectAllowed(projects, project, "jira_get_create_fields");
      const it = await getCreateMeta(project, issueType, "jira_get_create_fields");
      const fields = Object.entries(it.fields ?? {}).map(([id, f]) => ({
        id,
        name: f.name,
        required: f.required ?? false,
        type: f.schema?.custom ?? f.schema?.type,
        optionCount: f.allowedValues?.length,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { project, issueType: it.name, issueTypeId: it.id, fields },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  server.tool(
    "jira_get_field_options",
    "List the allowed values for a field in a project + issue type context (e.g. priorities, select-list custom fields). Scope-checked against your policy.",
    {
      project: z.string().describe("Project key"),
      issueType: z.string().describe("Issue type name or ID"),
      fieldId: z
        .string()
        .describe("Field ID, e.g. 'priority' or 'customfield_10001' — see jira_get_create_fields/jira_search_fields"),
      contains: z.string().optional().describe("Case-insensitive substring filter on option values"),
      limit: z.number().int().min(1).max(500).default(50),
    },
    audited("jira_get_field_options", getUsername, async ({ project, issueType, fieldId, contains, limit }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      assertProjectAllowed(projects, project, "jira_get_field_options");
      const it = await getCreateMeta(project, issueType, "jira_get_field_options");
      const field = it.fields?.[fieldId];
      if (!field)
        throw new Error(
          `field '${fieldId}' not on the create screen for ${it.name} in ${project}. ` +
            `Fields: ${Object.keys(it.fields ?? {}).join(", ")}`,
        );
      let opts = field.allowedValues ?? [];
      if (contains) {
        const c = contains.toLowerCase();
        opts = opts.filter((o) =>
          String(o.value ?? o.name ?? "").toLowerCase().includes(c),
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                fieldId,
                fieldName: field.name,
                count: Math.min(opts.length, limit),
                options: opts.slice(0, limit).map((o) => ({
                  id: o.id,
                  value: o.value ?? o.name,
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
}
