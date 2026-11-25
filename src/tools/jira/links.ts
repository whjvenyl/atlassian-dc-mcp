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

type IssueLink = {
  id: string;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
  outwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
};

// On GET issue/{key} each link exposes the OTHER issue: inwardIssue means
// the target sits at the inward end of the type's directed relation.
function linkShape(l: IssueLink) {
  const inward = !!l.inwardIssue;
  const target = l.inwardIssue ?? l.outwardIssue;
  return {
    id: l.id,
    type: l.type?.name,
    relation: inward ? l.type?.inward : l.type?.outward,
    target: target?.key,
    targetSummary: target?.fields?.summary,
    targetStatus: target?.fields?.status?.name,
  };
}

export function registerJiraLinksTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "jira_get_issue_links",
    "List links on an issue (blocks/duplicates/relates…) with direction and target. The issue's project must be inside your policy scope.",
    { key: z.string().describe("Issue key, e.g. SUP-123") },
    audited("jira_get_issue_links", getUsername, async ({ key }) => {
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      const issue = (await client.get(`/rest/api/2/issue/${key}`, {
        fields: "issuelinks,project",
      })) as {
        fields?: {
          project?: { key?: string };
          issuelinks?: IssueLink[];
        };
      };
      const proj = issue.fields?.project?.key;
      if (proj) assertProjectAllowed(projects, proj, "jira_get_issue_links");
      const links = (issue.fields?.issuelinks ?? []).map(linkShape);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ key, count: links.length, links }, null, 2),
          },
        ],
      };
    }),
  );

  server.tool(
    "jira_create_issue_link",
    "Link two issues — type from your DC link types (blocks, duplicates, relates…). Only when policy allows writes; BOTH projects must be inside your scope.",
    {
      type: z.string().describe("Link type name, e.g. 'Blocks', 'Duplicate', 'Relates'"),
      inwardKey: z
        .string()
        .describe("Issue at the inward end (e.g. 'is blocked by' X in a Blocks link)"),
      outwardKey: z
        .string()
        .describe("Issue at the outward end (e.g. 'blocks' X in a Blocks link)"),
      comment: z.string().optional().describe("Optional comment on the outward issue"),
    },
    audited("jira_create_issue_link", getUsername, async ({ type, inwardKey, outwardKey, comment }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        for (const k of [inwardKey, outwardKey]) {
          assertProjectAllowed(projects, k.split("-")[0], "jira_create_issue_link");
        }
        await client.post("/rest/api/2/issueLink", {
          type: { name: type },
          inwardIssue: { key: inwardKey },
          outwardIssue: { key: outwardKey },
          ...(comment ? { comment: { body: comment } } : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { linked: `${inwardKey} <-${type}-> ${outwardKey}` },
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
    "jira_delete_issue_link",
    "Remove a link between issues — pass the link ID from jira_get_issue_links. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key carrying the link"),
      linkId: z.string().describe("Link ID — see jira_get_issue_links"),
    },
    audited("jira_delete_issue_link", getUsername, async ({ key, linkId }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const projects = effectiveProjects(policy, await getUsername());
      try {
        assertProjectAllowed(projects, key.split("-")[0], "jira_delete_issue_link");
        await client.delete(`/rest/api/2/issueLink/${linkId}`);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ deleted: linkId, issue: key }, null, 2) },
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
