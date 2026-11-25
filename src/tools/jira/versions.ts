import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { audited } from "../../audit.js";
import { effectiveProjects } from "../../policy.js";
import {
  assertProjectAllowed,
  makeWriteGuard,
  type JiraCtx,
} from "../jira-common.js";

export function registerJiraVersionsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "jira_get_project_versions",
    "List a project's fixVersions — released/unreleased flags, dates. The project must be inside your policy scope.",
    {
      project: z.string().describe("Project key, e.g. SUP"),
    },
    audited("jira_get_project_versions", getUsername, async ({ project }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      assertProjectAllowed(projects, project, "jira_get_project_versions");
      const res = (await client.get(`/rest/api/2/project/${project}/versions`)) as {
        id: string;
        name: string;
        released?: boolean;
        archived?: boolean;
        releaseDate?: string;
        description?: string;
      }[];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project,
                versions: (res ?? []).map((v) => ({
                  id: v.id,
                  name: v.name,
                  released: v.released,
                  archived: v.archived,
                  releaseDate: v.releaseDate,
                  description: v.description,
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
    "jira_create_version",
    "Create a fixVersion in a project. Only when policy allows writes; the project must be inside your scope.",
    {
      project: z.string().describe("Project key"),
      name: z.string().describe("Version name, e.g. '1.4.0'"),
      releaseDate: z
        .string()
        .optional()
        .describe("YYYY-MM-DD"),
      description: z.string().optional(),
      released: z.boolean().default(false),
    },
    audited("jira_create_version", getUsername, async ({ project, name, releaseDate, description, released }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        assertProjectAllowed(projects, project, "jira_create_version");
        const v = (await client.post("/rest/api/2/version", {
          project,
          name,
          ...(releaseDate ? { releaseDate } : {}),
          ...(description ? { description } : {}),
          released,
        })) as { id?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ created: name, id: v.id, project }, null, 2),
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
    "jira_get_project_components",
    "List a project's components. The project must be inside your policy scope.",
    {
      project: z.string().describe("Project key"),
    },
    audited("jira_get_project_components", getUsername, async ({ project }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      assertProjectAllowed(projects, project, "jira_get_project_components");
      const res = (await client.get(`/rest/api/2/project/${project}/components`)) as {
        id: string;
        name: string;
        description?: string;
        lead?: { displayName?: string };
      }[];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project,
                components: (res ?? []).map((c) => ({
                  id: c.id,
                  name: c.name,
                  description: c.description,
                  lead: c.lead?.displayName,
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
