import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { audited } from "../../audit.js";
import { effectiveProjects } from "../../policy.js";
import {
  assertProjectAllowed,
  issueSummary,
  makeWriteGuard,
  type Issue,
  type JiraCtx,
} from "../jira-common.js";

/**
 * Agile API — /rest/agile/1.0, bundled with Jira Software on DC.
 * Scoping note: boards/sprints have no guaranteed single project, so
 * reads post-filter issues to the effective project list and write ops
 * check the board's location.projectKeyOrId when Jira reports one.
 */

type AgileIssue = { key?: string; fields?: { project?: { key?: string } } };

/** Drop issues whose project is outside scope; returns survivors. */
function scopeFilter<T extends AgileIssue>(
  issues: T[] | undefined,
  allowed: string[] | undefined,
): T[] {
  if (allowed === undefined || !issues) return issues ?? [];
  return issues.filter((i) => {
    const p = i.fields?.project?.key;
    return !p || allowed.includes(p);
  });
}

function sprintShape(s: {
  id?: number;
  name?: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
  originBoardId?: number;
}) {
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    startDate: s.startDate,
    endDate: s.endDate,
    goal: s.goal,
    originBoardId: s.originBoardId,
  };
}

export function registerJiraAgileTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  async function checkBoard(boardId: number, tool: string) {
    // Boards can span projects; Jira only reports location for boards
    // tied to a single project — check it when present.
    const board = (await client.get(`/rest/agile/1.0/board/${boardId}`)) as {
      id?: number;
      name?: string;
      location?: { projectKeyOrId?: string; displayName?: string };
    };
    const proj = board.location?.projectKeyOrId;
    if (proj) {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      assertProjectAllowed(projects, proj.toUpperCase(), tool);
    }
    return board;
  }

  server.tool(
    "jira_get_agile_boards",
    "List Jira Software boards — id, name, type (scrum/kanban), owning project when single-project. Unscoped list: board project membership is enforced on the per-board calls.",
    {
      type: z
        .enum(["scrum", "kanban", "simple"])
        .optional()
        .describe("Board type filter"),
      name: z.string().optional().describe("Name contains (case-insensitive)"),
      projectKeyOrId: z
        .string()
        .optional()
        .describe("Restrict to boards of one project"),
      limit: z.number().int().min(1).max(50).default(25),
      startAt: z.number().int().min(0).default(0),
    },
    audited(
      "jira_get_agile_boards",
      getUsername,
      async ({ type, name, projectKeyOrId, limit, startAt }) => {
        const res = (await client.get("/rest/agile/1.0/board", {
          ...(type ? { type } : {}),
          ...(name ? { name } : {}),
          ...(projectKeyOrId ? { projectKeyOrId } : {}),
          maxResults: limit,
          startAt,
        })) as {
          values?: {
            id?: number;
            name?: string;
            type?: string;
            location?: { projectKeyOrId?: string };
          }[];
          isLast?: boolean;
          total?: number;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  boards: (res.values ?? []).map((b) => ({
                    id: b.id,
                    name: b.name,
                    type: b.type,
                    project: b.location?.projectKeyOrId,
                  })),
                  isLast: res.isLast,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "jira_get_board_issues",
    "Issues on a board — post-filtered to your project scope (boards can span projects). Optionally narrow with extra JQL AND-ed in.",
    {
      boardId: z.number().int().describe("Board ID — see jira_get_agile_boards"),
      jql: z.string().optional().describe("Extra JQL AND-ed into the board's own filter"),
      fields: z.string().optional().describe("CSV of fields"),
      limit: z.number().int().min(1).max(100).default(50),
      startAt: z.number().int().min(0).default(0),
    },
    audited(
      "jira_get_board_issues",
      getUsername,
      async ({ boardId, jql, fields, limit, startAt }) => {
        await checkBoard(boardId, "jira_get_board_issues");
        const policy = getPolicy();
        const projects = effectiveProjects(policy, await getUsername());
        const res = (await client.get(
          `/rest/agile/1.0/board/${boardId}/issue`,
          {
            ...(jql ? { jql } : {}),
            fields: fields ?? "summary,status,assignee,issuetype,project",
            maxResults: limit,
            startAt,
          },
        )) as { issues?: Issue[]; total?: number };
        const visible = scopeFilter(res.issues, projects);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  boardId,
                  total: res.total,
                  returned: visible.length,
                  filtered: (res.issues?.length ?? 0) - visible.length || undefined,
                  issues: visible.map((i) => issueSummary(i, base)),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "jira_get_sprints_from_board",
    "Sprints on a board — state filter available (active/future/closed).",
    {
      boardId: z.number().int(),
      state: z
        .enum(["active", "future", "closed"])
        .optional()
        .describe("Filter by state"),
      limit: z.number().int().min(1).max(50).default(50),
    },
    audited(
      "jira_get_sprints_from_board",
      getUsername,
      async ({ boardId, state, limit }) => {
        await checkBoard(boardId, "jira_get_sprints_from_board");
        const res = (await client.get(
          `/rest/agile/1.0/board/${boardId}/sprint`,
          { ...(state ? { state } : {}), maxResults: limit },
        )) as { values?: Parameters<typeof sprintShape>[0][]; isLast?: boolean };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  boardId,
                  sprints: (res.values ?? []).map(sprintShape),
                  isLast: res.isLast,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "jira_get_sprint_issues",
    "Issues in a sprint — post-filtered to your project scope.",
    {
      sprintId: z.number().int().describe("Sprint ID — see jira_get_sprints_from_board"),
      jql: z.string().optional().describe("Extra JQL AND-ed in"),
      limit: z.number().int().min(1).max(100).default(50),
      startAt: z.number().int().min(0).default(0),
    },
    audited(
      "jira_get_sprint_issues",
      getUsername,
      async ({ sprintId, jql, limit, startAt }) => {
        const policy = getPolicy();
        const projects = effectiveProjects(policy, await getUsername());
        const res = (await client.get(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
          ...(jql ? { jql } : {}),
          fields: "summary,status,assignee,issuetype,project",
          maxResults: limit,
          startAt,
        })) as { issues?: Issue[]; total?: number };
        const visible = scopeFilter(res.issues, projects);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  sprintId,
                  total: res.total,
                  returned: visible.length,
                  filtered: (res.issues?.length ?? 0) - visible.length || undefined,
                  issues: visible.map((i) => issueSummary(i, base)),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "jira_get_issue_agile",
    "Agile view of an issue — sprint membership, epic link, flag/rank. The issue's project must be inside your policy scope.",
    {
      key: z.string().describe("Issue key"),
    },
    audited("jira_get_issue_agile", getUsername, async ({ key }) => {
      const res = (await client.get(`/rest/agile/1.0/issue/${key}`, {
        expand: "renderedFields",
      })) as {
        key?: string;
        fields?: Record<string, unknown> & {
          project?: { key?: string };
          sprint?: unknown;
          epic?: { name?: string; key?: string };
          flagged?: boolean;
        };
      };
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const proj = res.fields?.project?.key;
      if (proj) assertProjectAllowed(projects, proj, "jira_get_issue_agile");
      const f = res.fields ?? {};
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key: res.key ?? key,
                project: f.project?.key,
                sprint: f.sprint,
                epic: f.epic,
                flagged: f.flagged,
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
    "jira_create_sprint",
    "Create a sprint on a board. Only when policy allows writes; the board's owning project (when Jira reports one) must be inside your scope.",
    {
      boardId: z.number().int().describe("Origin board ID"),
      name: z.string().describe("Sprint name"),
      startDate: z.string().optional().describe("ISO 8601"),
      endDate: z.string().optional().describe("ISO 8601"),
      goal: z.string().optional(),
    },
    audited(
      "jira_create_sprint",
      getUsername,
      async ({ boardId, name, startDate, endDate, goal }) => {
        const denied = writeGuard();
        if (denied) return denied;
        try {
          await checkBoard(boardId, "jira_create_sprint");
          const s = (await client.post("/rest/agile/1.0/sprint", {
            name,
            originBoardId: boardId,
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
            ...(goal ? { goal } : {}),
          })) as Parameters<typeof sprintShape>[0];
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(sprintShape(s), null, 2),
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
      },
    ),
  );

  server.tool(
    "jira_update_sprint",
    "Update a sprint — rename, set goal/dates, or change state (future → active → closed). Only when policy allows writes.",
    {
      sprintId: z.number().int(),
      name: z.string().optional(),
      goal: z.string().optional(),
      state: z.enum(["active", "closed", "future"]).optional(),
      startDate: z.string().optional().describe("ISO 8601"),
      endDate: z.string().optional().describe("ISO 8601"),
    },
    audited(
      "jira_update_sprint",
      getUsername,
      async ({ sprintId, name, goal, state, startDate, endDate }) => {
        const denied = writeGuard();
        if (denied) return denied;
        try {
          const s = (await client.put(`/rest/agile/1.0/sprint/${sprintId}`, {
            ...(name !== undefined ? { name } : {}),
            ...(goal !== undefined ? { goal } : {}),
            ...(state !== undefined ? { state } : {}),
            ...(startDate !== undefined ? { startDate } : {}),
            ...(endDate !== undefined ? { endDate } : {}),
          })) as Parameters<typeof sprintShape>[0];
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(sprintShape(s), null, 2),
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
      },
    ),
  );

  server.tool(
    "jira_get_epic_issues",
    "Issues in an epic — post-filtered to your project scope; the epic's own project must be inside your scope.",
    {
      epicKey: z.string().describe("Epic issue key"),
      limit: z.number().int().min(1).max(100).default(50),
      startAt: z.number().int().min(0).default(0),
    },
    audited(
      "jira_get_epic_issues",
      getUsername,
      async ({ epicKey, limit, startAt }) => {
        const policy = getPolicy();
        const projects = effectiveProjects(policy, await getUsername());
        assertProjectAllowed(projects, epicKey.split("-")[0], "jira_get_epic_issues");
        const res = (await client.get(`/rest/agile/1.0/epic/${epicKey}/issue`, {
          fields: "summary,status,assignee,issuetype,project",
          maxResults: limit,
          startAt,
        })) as { issues?: Issue[]; total?: number };
        const visible = scopeFilter(res.issues, projects);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  epic: epicKey,
                  total: res.total,
                  returned: visible.length,
                  issues: visible.map((i) => issueSummary(i, base)),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "jira_move_issues_to_epic",
    "Add issues to an epic — every issue's project AND the epic's project must be inside your scope. Only when policy allows writes.",
    {
      epicKey: z.string().describe("Epic issue key"),
      issueKeys: z
        .array(z.string())
        .min(1)
        .describe("Issue keys to move into the epic"),
    },
    audited(
      "jira_move_issues_to_epic",
      getUsername,
      async ({ epicKey, issueKeys }) => {
        const denied = writeGuard();
        if (denied) return denied;
        const policy = getPolicy();
        const projects = effectiveProjects(policy, await getUsername());
        try {
          for (const k of [epicKey, ...issueKeys]) {
            assertProjectAllowed(projects, k.split("-")[0], "jira_move_issues_to_epic");
          }
          await client.post(`/rest/agile/1.0/epic/${epicKey}/issue`, {
            issues: issueKeys,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { epic: epicKey, moved: issueKeys },
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
      },
    ),
  );
}
