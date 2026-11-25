import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianClient } from "../client.js";
import { confluenceReadOnly, type Policy } from "../policy.js";

export type Page = {
  id: string;
  title: string;
  type: string;
  space?: { key?: string; name?: string };
  _links?: { webui?: string; base?: string };
  body?: { storage?: { value?: string } };
  version?: { number?: number };
  ancestors?: { id: string }[];
};

export type ConfluenceCtx = {
  server: McpServer;
  client: AtlassianClient;
  base: string;
  getPolicy: () => Policy;
  getUsername: () => Promise<string | null>;
};

export function pageSummary(p: Page, base: string): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    type: p.type,
    space: p.space?.key,
    url: p._links?.base
      ? `${p._links.base}${p._links.webui ?? ""}`
      : `${base}/pages/viewpage.action?pageId=${p.id}`,
    version: p.version?.number,
  };
}

export function assertSpaceAllowed(
  allowed: string[] | undefined,
  space: string,
  ctx: string,
) {
  if (allowed !== undefined && !allowed.includes(space)) {
    throw new Error(
      allowed.length === 0
        ? `Policy denies access to all Confluence spaces (${ctx}).`
        : `Policy denies access to space '${space}' (${ctx}). ` +
            `Your allowed spaces: ${allowed.join(", ")}. ` +
            `Pages in those spaces remain reachable via confluence_get_page/confluence_search.`,
    );
  }
}

export function checkPageSpace(
  page: Page,
  allowed: string[] | undefined,
  ctx: string,
) {
  const key = page.space?.key;
  if (key) assertSpaceAllowed(allowed, key, ctx);
}

export function denyIfEmpty(spaces: string[] | undefined, tool: string) {
  if (spaces && spaces.length === 0)
    throw new Error(
      `Policy denies ${tool}: your effective Confluence scope is empty ` +
        `(global cap ∩ your rules = nothing). Options: call ` +
        `confluence_list_spaces to confirm, ask the deployment admin to ` +
        `widen policy.yaml for your user, or use a PAT for a different ` +
        `account. Retrying with different queries will not bypass this.`,
    );
}

export function makeWriteGuard(getPolicy: () => Policy) {
  return (): { isError: true; content: { type: "text"; text: string }[] } | null => {
    if (confluenceReadOnly(getPolicy())) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Writes are disabled by server policy (global.allowWrites=false or confluence.readOnly=true).",
          },
        ],
      };
    }
    return null;
  };
}
