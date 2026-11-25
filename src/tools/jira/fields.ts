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

export function registerJiraFieldsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  type FieldMeta = {
    name?: string;
    required?: boolean;
    schema?: { type?: string; custom?: string };
    allowedValues?: { id?: string; value?: string; name?: string }[];
  };
  type IssueTypeMeta = {
    id: string;
    name: string;
    fields?: Record<string, FieldMeta>;
  };

  /**
   * createmeta has two shapes across DC lines:
   *  - DC 11+: /issue/createmeta/{project}/issuetypes(+ /{issueTypeId})
   *    → PageBean, field meta in values[]
   *  - DC 8/9/10 legacy: /issue/createmeta?projectKeys=&expand=projects.issuetypes.fields
   *    → projects[].issuetypes[].fields{}
   * Try DC 11 first; fall back to legacy on failure.
   */
  const getCreateMeta = async (
    project: string,
    issueType: string,
    ctx: string,
  ): Promise<IssueTypeMeta> => {
    // ── DC 11 path form ──
    try {
      const types = (await client.get(
        `/rest/api/2/issue/createmeta/${project}/issuetypes`,
        { maxResults: 200 },
      )) as { values?: { id?: string; name?: string }[]; results?: { id?: string; name?: string }[] };
      const list = types.values ?? types.results ?? [];
      const match = list.find(
        (t) =>
          t.id === issueType ||
          (t.name ?? "").toLowerCase() === issueType.toLowerCase(),
      );
      if (match) {
        const fm = (await client.get(
          `/rest/api/2/issue/createmeta/${project}/issuetypes/${match.id}`,
          { maxResults: 200 },
        )) as {
          values?: ({ fieldId?: string; id?: string } & FieldMeta)[];
          results?: ({ fieldId?: string; id?: string } & FieldMeta)[];
        };
        const raw = fm.values ?? fm.results ?? [];
        const fields: Record<string, FieldMeta> = {};
        for (const f of raw) {
          const key = f.fieldId ?? f.id;
          if (key) fields[key] = f;
        }
        return { id: String(match.id), name: String(match.name), fields };
      }
      // fall through to legacy when the type list came back but lacks
      // the requested type — some builds paginate differently
      if (list.length > 0) {
        throw Object.assign(
          new Error(
            `issue type '${issueType}' not found in ${project}. ` +
              `Available: ${list.map((t) => t.name).join(", ") || "none"} (${ctx})`,
          ),
          { final: true },
        );
      }
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      // non-final error → try legacy shape below
    }

    // ── DC ≤10 legacy query form ──
    const res = (await client.get("/rest/api/2/issue/createmeta", {
      projectKeys: project,
      expand: "projects.issuetypes.fields",
    })) as {
      projects?: { issuetypes?: IssueTypeMeta[] }[];
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
}
