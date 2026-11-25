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
  ancestors?: { id: string }[];
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
    "Search Confluence — pass plain text (uses siteSearch like the web UI) or CQL. Your query is AND-ed with the space allowlist from the server policy — you cannot widen it.",
    {
      query: z
        .string()
        .describe("Plain text ('deploy runbook') or CQL ('type = page AND label = runbook')"),
      cql: z
        .string()
        .optional()
        .describe("Explicit CQL — overrides query's auto-detection"),
      spacesFilter: z
        .string()
        .optional()
        .describe("Comma-separated space keys — intersected with your policy scope"),
      limit: z.number().int().min(1).max(100).default(20),
      start: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    audited("confluence_search", getUsername, async ({ query, cql, spacesFilter, limit, start }) => {
      const policy = getPolicy();
      let spaces = effectiveSpaces(policy, await getUsername());
      denyIfEmpty(spaces, "confluence_search");
      if (spacesFilter) {
        const wanted = spacesFilter.split(",").map((s) => s.trim()).filter(Boolean);
        spaces = spaces === undefined
          ? wanted
          : spaces.filter((s) => wanted.includes(s));
        denyIfEmpty(spaces, "confluence_search");
      }
      const isCql = (s: string) => /\s(AND|OR|NOT)\s|[=~<>!]|ORDER BY/i.test(s);
      const q = cql ?? (isCql(query) ? query : `siteSearch ~ "${query.replace(/"/g, '\\"')}"`);
      const scoped =
        spaces && spaces.length > 0
          ? `(${q}) AND space in (${spaces.map((s) => `"${s}"`).join(",")})`
          : q;
      const res = (await client.get("/rest/api/content/search", {
        cql: scoped,
        limit,
        start,
        expand: "content.space",
      })) as { results?: Page[]; size?: number };
      const count = res.size ?? res.results?.length ?? 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count,
                start,
                nextStart: start + (res.results?.length ?? 0),
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
    "Fetch a Confluence page — by numeric ID, or by title + space. Refused if the page's space is outside your policy scope.",
    {
      pageId: z.string().optional().describe("Numeric page ID — or pass title + space"),
      title: z.string().optional().describe("Exact page title — requires space"),
      space: z.string().optional().describe("Space key — required with title"),
      expand: z
        .string()
        .default("body.storage,version,space")
        .describe("Comma-separated expand list"),
      includeMetadata: z
        .boolean()
        .default(false)
        .describe("Also return history (creator, created date) and labels"),
    },
    audited("confluence_get_page", getUsername, async ({ pageId, title, space, expand, includeMetadata }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const wantExpand =
        expand + (includeMetadata ? ",history,metadata.labels" : "");
      let page: Page & {
        history?: { createdDate?: string; createdBy?: { displayName?: string } };
        metadata?: { labels?: { results?: { name?: string }[] } };
      };
      if (pageId) {
        page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: wantExpand,
        })) as typeof page;
      } else {
        if (!title || !space)
          throw new Error("pass pageId, or title + space together");
        assertSpaceAllowed(spaces, space, "confluence_get_page");
        const found = (await client.get("/rest/api/content", {
          spaceKey: space,
          title,
          expand: wantExpand,
        })) as { results?: typeof page[] };
        page = found.results?.[0] as typeof page;
        if (!page)
          throw new Error(`page '${title}' not found in space ${space}`);
      }
      checkPageSpace(page, spaces, "confluence_get_page");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...pageSummary(page, base),
                body: page.body?.storage?.value,
                ...(includeMetadata
                  ? {
                      created: page.history?.createdDate,
                      createdBy: page.history?.createdBy?.displayName,
                      labels: (page.metadata?.labels?.results ?? []).map(
                        (l) => l.name,
                      ),
                    }
                  : {}),
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
      start: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    audited("confluence_get_page_children", getUsername, async ({ pageId, limit, start }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const res = (await client.get(
        `/rest/api/content/${pageId}/child/page`,
        { limit, start, expand: "space" },
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
      versionComment: z.string().optional().describe("Comment stored on this version"),
      isMinorEdit: z.boolean().default(false).describe("Minor edit — skips watcher notifications"),
    },
    audited("confluence_update_page", getUsername, async ({ pageId, title, body, versionComment, isMinorEdit }) => {
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
          version: {
            number: nextVersion,
            ...(isMinorEdit ? { minorEdit: true } : {}),
            ...(versionComment ? { message: versionComment } : {}),
          },
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

  // ── spaces ──────────────────────────────────────────────────────────────

  server.tool(
    "confluence_get_space_detail",
    "Full detail on one space — name, type, description, homepage ID. Must be inside your policy scope.",
    { space: z.string().describe("Space key, e.g. DOC") },
    audited("confluence_get_space_detail", getUsername, async ({ space }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      assertSpaceAllowed(spaces, space, "confluence_get_space_detail");
      const res = (await client.get(`/rest/api/space/${space}`, {
        expand: "description.plain,homepage,metadata.labels",
      })) as {
        key?: string;
        name?: string;
        type?: string;
        description?: { plain?: { value?: string } };
        homepage?: { id?: string; title?: string };
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key: res.key,
                name: res.name,
                type: res.type,
                description: res.description?.plain?.value,
                homepage: res.homepage,
                url: `${base}/display/${res.key}`,
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
    "confluence_get_space_content",
    "List content in a space — pages, blogs, or all types. Space must be inside your policy scope.",
    {
      space: z.string().describe("Space key"),
      type: z
        .enum(["page", "blogpost", "comment", "attachment"])
        .optional()
        .describe("Content type — omit for all"),
      limit: z.number().int().min(1).max(100).default(25),
      start: z.number().int().min(0).default(0),
    },
    audited("confluence_get_space_content", getUsername, async ({ space, type, limit, start }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      assertSpaceAllowed(spaces, space, "confluence_get_space_content");
      const res = (await client.get("/rest/api/content", {
        spaceKey: space,
        ...(type ? { type } : {}),
        limit,
        start,
        expand: "version",
      })) as { results?: Page[]; size?: number };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                space,
                count: res.size ?? res.results?.length ?? 0,
                start,
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

  // ── page lifecycle ──────────────────────────────────────────────────────

  server.tool(
    "confluence_get_page_history",
    "Version history of a page — every version with author and timestamp. Page's space must be inside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    audited("confluence_get_page_history", getUsername, async ({ pageId, limit }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const page = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(page, spaces, "confluence_get_page_history");
      const res = (await client.get(`/rest/api/content/${pageId}/version`, {
        limit,
      })) as {
        results?: {
          number?: number;
          when?: string;
          by?: { displayName?: string };
          message?: string;
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                versions: (res.results ?? []).map((v) => ({
                  number: v.number,
                  when: v.when,
                  by: v.by?.displayName,
                  message: v.message,
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
    "confluence_delete_page",
    "Delete a page (moves it to trash on DC — recoverable by a space admin). Only when policy allows writes; page's space must be inside your scope.",
    { pageId: z.string().describe("Numeric page ID") },
    audited("confluence_delete_page", getUsername, async ({ pageId }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(page, spaces, "confluence_delete_page");
        await client.delete(`/rest/api/content/${pageId}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ deleted: pageId, title: page.title }, null, 2),
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
    "confluence_move_page",
    "Re-parent a page under a different parent page. Only when policy allows writes; page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      newParentId: z.string().describe("ID of the new parent page — must be in the same space"),
    },
    audited("confluence_move_page", getUsername, async ({ pageId, newParentId }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space,version",
        })) as Page;
        checkPageSpace(page, spaces, "confluence_move_page");
        const parent = (await client.get(`/rest/api/content/${newParentId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(parent, spaces, "confluence_move_page");
        const spaceKey = page.space?.key ?? "";
        const res = (await client.post(
          `/rest/api/content/${pageId}/move/${parent.id ?? newParentId}/${spaceKey}`,
          {},
        )) as { id?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ moved: pageId, under: newParentId }, null, 2),
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
    "confluence_copy_page",
    "Duplicate a page — title required, optionally under a different parent. Only when policy allows writes; source and destination must be inside your scope.",
    {
      pageId: z.string().describe("Source page ID"),
      title: z.string().describe("Title for the copy"),
      destinationParentId: z
        .string()
        .optional()
        .describe("Parent for the copy — default: same parent as source"),
    },
    audited("confluence_copy_page", getUsername, async ({ pageId, title, destinationParentId }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space,body.storage,ancestors",
        })) as Page;
        checkPageSpace(page, spaces, "confluence_copy_page");
        const parentId =
          destinationParentId ??
          (page.ancestors ?? []).slice(-1)[0]?.id;
        const created = (await client.post("/rest/api/content", {
          type: "page",
          title,
          space: { key: page.space?.key },
          ...(parentId ? { ancestors: [{ id: parentId }] } : {}),
          body: { storage: { value: page.body?.storage?.value ?? "", representation: "storage" } },
        })) as Page;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { copiedFrom: pageId, ...pageSummary(created, base) },
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

  // ── labels & users ──────────────────────────────────────────────────────

  server.tool(
    "confluence_get_labels",
    "Labels on a page — the values CQL `label = x` matches against. Page's space must be inside your policy scope.",
    { pageId: z.string().describe("Numeric page ID") },
    audited("confluence_get_labels", getUsername, async ({ pageId }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const page = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(page, spaces, "confluence_get_labels");
      const res = (await client.get(`/rest/api/content/${pageId}/label`)) as {
        results?: { id?: string; name?: string; prefix?: string }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                labels: (res.results ?? []).map((l) => l.name),
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
    "confluence_add_label",
    "Add a label to a page. Only when policy allows writes; page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      label: z.string().describe("Label name — lowercase, hyphens for spaces"),
    },
    audited("confluence_add_label", getUsername, async ({ pageId, label }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(page, spaces, "confluence_add_label");
        const res = (await client.post(`/rest/api/content/${pageId}/label`, [
          { prefix: "global", name: label },
        ])) as { results?: { name?: string }[] };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { pageId, labels: (res.results ?? []).map((l) => l.name) },
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
    "confluence_search_users",
    "Find Confluence users by name — DC `/rest/api/search/user` CQL. Useful before assigning comments or tracking authors.",
    {
      query: z.string().describe("Name or username substring"),
      limit: z.number().int().min(1).max(50).default(10),
    },
    audited("confluence_search_users", getUsername, async ({ query, limit }) => {
      const res = (await client.get("/rest/api/search/user", {
        cql: `type=user AND user.fullname ~ "${query.replace(/"/g, '\\"')}"`,
        limit,
      })) as {
        results?: {
          user?: { username?: string; displayName?: string };
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                users: (res.results ?? []).map((r) => ({
                  username: r.user?.username,
                  displayName: r.user?.displayName,
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
