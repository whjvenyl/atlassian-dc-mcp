import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianClient } from "../client.js";
import { jiraReadOnly, type Policy } from "../policy.js";

export type Issue = {
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

export type JiraCtx = {
  server: McpServer;
  client: AtlassianClient;
  base: string;
  getPolicy: () => Policy;
  getUsername: () => Promise<string | null>;
};

export function issueSummary(i: Issue, base: string): Record<string, unknown> {
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

export function assertProjectAllowed(
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

export function denyIfEmpty(projects: string[] | undefined, tool: string) {
  if (projects && projects.length === 0)
    throw new Error(
      `Policy denies ${tool}: your effective Jira scope is empty ` +
        `(global cap ∩ your rules = nothing). Options: call ` +
        `jira_list_projects to confirm, ask the deployment admin to ` +
        `widen policy.yaml for your user, or use a PAT for a different ` +
        `account. Retrying with different queries will not bypass this.`,
    );
}

export function makeWriteGuard(getPolicy: () => Policy) {
  return (): { isError: true; content: { type: "text"; text: string }[] } | null => {
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
}
