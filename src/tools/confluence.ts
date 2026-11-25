import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../client.js";
import {
  confluenceReadOnly,
  effectiveSpaces,
  type Policy,
} from "../policy.js";

/**
 * Confluence DC REST API reference: /rest/api/*
 * Enforcement model:
 *   - search: policy space list is AND-ed into the caller's CQL
 *   - get/create: the page's space is checked against the effective list
 *   - effective list undefined => unrestricted; [] => deny all
 */

type Page = {
  id: string;
  title: string;
  type: string;
  space?: { key?: string; name?: string };
  _links?: { webui?: string; base?: string };
  body?: { storage?: { value?: string } };
  version?: { number?: number };
};

function pageSummary(p: Page, base: string): Record<string, unknown> {
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

function assertSpaceAllowed(
  allowed: string[] | undefined,
  space: string,
  ctx: string,
) {
  if (allowed !== undefined && !allowed.includes(space)) {
    throw new Error(
      allowed.length === 0
        ? `Policy denies access to all Confluence spaces.`
        : `Policy denies access to space '${space}' (${ctx}). Allowed: ${allowed.join(", ") || "none"}.`,
    );
  }
}

function checkPageSpace(
  page: Page,
  allowed: string[] | undefined,
  ctx: string,
) {
  const key = page.space?.key;
  if (key) assertSpaceAllowed(allowed, key, ctx);
}

export function registerConfluenceTools(
  server: McpServer,
  client: AtlassianClient,
  base: string,
  getPolicy: () => Policy,
  getUsername: () => Promise<string | null>,
): void {
  const denyIfEmpty = (spaces: string[] | undefined, tool: string) => {
    if (spaces && spaces.length === 0)
      throw new Error(
        `Policy denies ${tool}: no Confluence spaces are permitted for you.`,
      );
  };

  server.tool(
    "confluence_search",
    "Search Confluence with CQL. Your query is AND-ed with the space allowlist from the server policy — you cannot widen it.",
    {
      cql: z
        .string()
        .describe("CQL, e.g. 'text ~ \"deploy\"' or 'type = page AND label = runbook'"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ cql, limit }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      denyIfEmpty(spaces, "confluence_search");
      const scoped =
        spaces && spaces.length > 0
          ? `(${cql}) AND space in (${spaces.map((s) => `"${s}"`).join(",")})`
          : cql;
      const res = (await client.get("/rest/api/content/search", {
        cql: scoped,
        limit,
        expand: "content.space",
      })) as { results?: Page[]; size?: number };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: res.size ?? res.results?.length ?? 0,
                effectiveCQL: scoped,
                results: (res.results ?? []).map((p) => pageSummary(p, base)),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "confluence_get_page",
    "Fetch a Confluence page by ID, including its body. Refused if the page's space is outside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      expand: z
        .string()
        .default("body.storage,version,space")
        .describe("Comma-separated expand list"),
    },
    async ({ pageId, expand }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const page = (await client.get(`/rest/api/content/${pageId}`, {
        expand,
      })) as Page;
      checkPageSpace(page, spaces, "confluence_get_page");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...pageSummary(page, base),
                body: page.body?.storage?.value,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "confluence_get_page_children",
    "List child pages of a page. Each result is checked against your space allowlist; denied children are dropped.",
    {
      pageId: z.string(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ pageId, limit }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const res = (await client.get(
        `/rest/api/content/${pageId}/child/page`,
        { limit, expand: "space" },
      )) as { results?: Page[] };
      const visible = (res.results ?? []).filter((p) => {
        try {
          checkPageSpace(p, spaces, "confluence_get_page_children");
          return true;
        } catch {
          return false;
        }
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: visible.length,
                results: visible.map((p) => pageSummary(p, base)),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "confluence_list_spaces",
    "List Confluence spaces you may see under the server policy (global cap ∩ your rules ∩ your PAT's DC permissions).",
    { limit: z.number().int().min(1).max(200).default(50) },
    async ({ limit }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      denyIfEmpty(spaces, "confluence_list_spaces");
      const res = (await client.get("/rest/api/space", {
        limit: spaces ? Math.min(limit * 3, 200) : limit,
      })) as {
        results?: { key: string; name: string; type: string }[];
      };
      const filtered = (res.results ?? []).filter(
        (s) => spaces === undefined || spaces.includes(s.key),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                policySpaces: spaces ?? "unrestricted",
                count: filtered.length,
                spaces: filtered,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "confluence_create_page",
    "Create a Confluence page. Only registered when policy allows writes; the target space must be inside your policy scope.",
    {
      space: z.string().describe("Target space key"),
      title: z.string(),
      body: z
        .string()
        .describe("Page body in Confluence storage format (XHTML)"),
      parentId: z
        .string()
        .optional()
        .describe("Optional parent page ID"),
    },
    async ({ space, title, body, parentId }) => {
      const policy = getPolicy();
      if (confluenceReadOnly(policy)) {
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
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        assertSpaceAllowed(spaces, space, "confluence_create_page");
        const page = (await client.post("/rest/api/content", {
          type: "page",
          title,
          space: { key: space },
          ...(parentId
            ? { ancestors: [{ id: parentId }] }
            : {}),
          body: { storage: { value: body, representation: "storage" } },
        })) as Page;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(pageSummary(page, base), null, 2),
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
    },
  );
}
