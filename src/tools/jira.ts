import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianClient } from "../client.js";
import type { Policy } from "../policy.js";
import { registerJiraCommentsTools } from "./jira/comments.js";
import { registerJiraFieldsTools } from "./jira/fields.js";
import { registerJiraIssuesTools } from "./jira/issues.js";
import { registerJiraAgileTools } from "./jira/agile.js";
import { registerJiraAttachmentsTools } from "./jira/attachments.js";
import { registerJiraLinksTools } from "./jira/links.js";
import { registerJiraMetaTools } from "./jira/meta.js";
import { registerJiraSearchTools } from "./jira/search.js";
import { registerJiraVersionsTools } from "./jira/versions.js";

/**
 * Jira DC REST API reference: /rest/api/2/*
 * Enforcement model:
 *   - search: policy project list is AND-ed into the caller's JQL
 *   - get/create: the issue's project is checked against the effective list
 *   - effective list undefined => unrestricted; [] => deny all
 */
export function registerJiraTools(
  server: McpServer,
  client: AtlassianClient,
  base: string,
  getPolicy: () => Policy,
  getUsername: () => Promise<string | null>,
): void {
  const ctx = { server, client, base, getPolicy, getUsername };
  registerJiraSearchTools(ctx);
  registerJiraIssuesTools(ctx);
  registerJiraCommentsTools(ctx);
  registerJiraMetaTools(ctx);
  registerJiraFieldsTools(ctx);
  registerJiraLinksTools(ctx);
  registerJiraVersionsTools(ctx);
  registerJiraAttachmentsTools(ctx);
  registerJiraAgileTools(ctx);
}
