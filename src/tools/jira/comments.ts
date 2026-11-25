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

export function registerJiraCommentsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

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
}
