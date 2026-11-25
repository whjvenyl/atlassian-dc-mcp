import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../client.js";
import { audited } from "../audit.js";
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
        ? `Policy denies access to all Confluence spaces (${ctx}).`
        : `Policy denies access to space '${space}' (${ctx}). ` +
            `Your allowed spaces: ${allowed.join(", ")}. ` +
            `Pages in those spaces remain reachable via confluence_get_page/confluence_search.`,
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
        `Policy denies ${tool}: your effective Confluence scope is empty ` +
          `(global cap ∩ your rules = nothing). Options: call ` +
          `confluence_list_spaces to confirm, ask the deployment admin to ` +
          `widen policy.yaml for your user, or use a PAT for a different ` +
          `account. Retrying with different queries will not bypass this.`,
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
    audited("confluence_search", getUsername, async ({ cql, limit }) => {
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
    }),
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
    audited("confluence_get_page", getUsername, async ({ pageId, expand }) => {
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
    }),
  );

  server.tool(
    "confluence_get_page_children",
    "List child pages of a page. Each result is checked against your space allowlist; denied children are dropped.",
    {
      pageId: z.string(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    audited("confluence_get_page_children", getUsername, async ({ pageId, limit }) => {
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
    }),
  );

  server.tool(
    "confluence_list_spaces",
    "List Confluence spaces you may see under the server policy (global cap ∩ your rules ∩ your PAT's DC permissions).",
    { limit: z.number().int().min(1).max(200).default(50) },
    audited("confluence_list_spaces", getUsername, async ({ limit }) => {
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
    }),
  );

  // ── write tools (gated by global.allowWrites + scope checks) ──

  const writeGuard = (): { isError: true; content: { type: "text"; text: string }[] } | null => {
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

  server.tool(
    "confluence_get_comments",
    "List comments on a Confluence page (author, date, body). Refused if the page's space is outside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    audited("confluence_get_comments", getUsername, async ({ pageId, limit }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      // resolve the parent page's space first — comment list alone doesn't carry it
      const parent = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(parent, spaces, "confluence_get_comments");
      const res = (await client.get(`/rest/api/content/${pageId}/child/comment`, {
        limit,
        expand: "body.view,version,container",
      })) as {
        results?: {
          id: string;
          body?: { view?: { value?: string } };
          version?: { by?: { displayName?: string }; when?: string };
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                count: res.results?.length ?? 0,
                comments: (res.results ?? []).map((c) => ({
                  id: c.id,
                  author: c.version?.by?.displayName,
                  at: c.version?.when,
                  body: c.body?.view?.value,
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
    "confluence_current_user",
    "Return the Atlassian identity your PAT resolves to on Confluence — the same identity per-user policy rules key on.",
    {},
    audited("confluence_current_user", getUsername, async () => {
      const me = (await client.get("/rest/api/user/current")) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username: me.username,
                userKey: me.userKey,
                displayName: me.displayName,
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
    "confluence_add_comment",
    "Add a comment to a Confluence page. Only when policy allows writes; the page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      body: z.string().describe("Comment body in storage format (XHTML)"),
    },
    audited("confluence_add_comment", getUsername, async ({ pageId, body }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const parent = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(parent, spaces, "confluence_add_comment");
        const created = (await client.post("/rest/api/content", {
          type: "comment",
          container: { id: pageId, type: "page" },
          body: { storage: { value: body, representation: "storage" } },
        })) as Page & { version?: { by?: { displayName?: string } } };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  commented: pageId,
                  id: created.id,
                  author: created.version?.by?.displayName,
                },
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
    "confluence_update_page",
    "Update a Confluence page's title and/or body (auto-bumps version). Only when policy allows writes; the page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      title: z.string().optional().describe("New title (omit to keep)"),
      body: z.string().optional().describe("New body in storage format (XHTML; omit to keep)"),
    },
    audited("confluence_update_page", getUsername, async ({ pageId, title, body }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        if (title === undefined && body === undefined)
          throw new Error("nothing to update — pass title and/or body");
        const current = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space,version,body.storage",
        })) as Page;
        checkPageSpace(current, spaces, "confluence_update_page");
        const nextVersion = (current.version?.number ?? 0) + 1;
        const updated = (await client.put(`/rest/api/content/${pageId}`, {
          id: pageId,
          type: "page",
          title: title ?? current.title,
          version: { number: nextVersion },
          ...(body !== undefined
            ? { body: { storage: { value: body, representation: "storage" } } }
            : {}),
        })) as Page;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { updated: pageId, ...pageSummary(updated, base) },
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
    audited("confluence_create_page", getUsername, async ({ space, title, body, parentId }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
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
    }),
  );
}
