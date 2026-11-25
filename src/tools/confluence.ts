import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianClient } from "../client.js";
import type { Policy } from "../policy.js";
import { registerConfluenceCommentsTools } from "./confluence/comments.js";
import { registerConfluenceLabelsTools } from "./confluence/labels.js";
import { registerConfluencePagesTools } from "./confluence/pages.js";
import { registerConfluencePermissionsTools } from "./confluence/permissions.js";
import { registerConfluenceSearchTools } from "./confluence/search.js";
import { registerConfluenceSpacesTools } from "./confluence/spaces.js";
import { registerConfluenceUsersTools } from "./confluence/users.js";

/**
 * Confluence DC REST API reference: /rest/api/*
 * Enforcement model:
 *   - search: policy space list is AND-ed into the caller's CQL
 *   - get/create: the page's space is checked against the effective list
 *   - effective list undefined => unrestricted; [] => deny all
 */
export function registerConfluenceTools(
  server: McpServer,
  client: AtlassianClient,
  base: string,
  getPolicy: () => Policy,
  getUsername: () => Promise<string | null>,
): void {
  const ctx = { server, client, base, getPolicy, getUsername };
  registerConfluenceSearchTools(ctx);
  registerConfluencePagesTools(ctx);
  registerConfluenceCommentsTools(ctx);
  registerConfluenceSpacesTools(ctx);
  registerConfluencePermissionsTools(ctx);
  registerConfluenceLabelsTools(ctx);
  registerConfluenceUsersTools(ctx);
}
