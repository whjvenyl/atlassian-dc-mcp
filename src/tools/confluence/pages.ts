import { z } from "zod";
import { audited } from "../../audit.js";
import { effectiveSpaces } from "../../policy.js";
import {
  assertSpaceAllowed,
  checkPageSpace,
  denyIfEmpty,
  makeWriteGuard,
  pageSummary,
  type ConfluenceCtx,
  type Page,
} from "../confluence-common.js";

export function registerConfluencePagesTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

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
    "confluence_get_descendants",
    "Recursive page tree under a page — ids + titles of every descendant (page-children flattened). The root page's space must be inside your policy scope; descendants outside the space are dropped.",
    {
      pageId: z.string().describe("Numeric page ID — the tree's root"),
      depth: z
        .enum(["all", "1"])
        .default("all")
        .describe("'all' walks the whole tree; '1' is direct children only"),
      limit: z.number().int().min(1).max(200).default(100),
      start: z.number().int().min(0).default(0),
    },
    audited(
      "confluence_get_descendants",
      getUsername,
      async ({ pageId, depth, limit, start }) => {
        const policy = getPolicy();
        const spaces = effectiveSpaces(policy, await getUsername());
        const root = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(root, spaces, "confluence_get_descendants");
        const res = (await client.get(
          `/rest/api/content/${pageId}/descendant/page`,
          { limit, start, expand: "space,version", ...(depth === "1" ? { depth: "1" } : { depth: "all" }) },
        )) as { results?: Page[]; size?: number };
        const pages = (res.results ?? []).filter((p) => {
          const k = p.space?.key;
          return spaces === undefined || (k !== undefined && spaces.includes(k));
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  root: pageId,
                  count: pages.length,
                  filtered: (res.results?.length ?? 0) - pages.length || undefined,
                  pages: pages.map((p) => pageSummary(p, base)),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "confluence_get_page_version",
    "A page's body as it was at a specific version — pass the number from confluence_get_page_history. The page's space must be inside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      version: z
        .number()
        .int()
        .min(1)
        .describe("Version number — see confluence_get_page_history"),
    },
    audited(
      "confluence_get_page_version",
      getUsername,
      async ({ pageId, version }) => {
        const policy = getPolicy();
        const spaces = effectiveSpaces(policy, await getUsername());
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          version,
          expand: "space,body.storage,version",
        })) as Page & {
          version?: { number?: number; message?: string; when?: string };
        };
        checkPageSpace(page, spaces, "confluence_get_page_version");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: page.id,
                  title: page.title,
                  version: page.version?.number,
                  versionMessage: page.version?.message,
                  when: page.version?.when,
                  body: page.body?.storage?.value,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "confluence_convert_body",
    "Convert content between representations — storage (XHTML), view (rendered), editor, export_view. Free-standing conversion; no space cap (the body you pass is already yours).",
    {
      body: z.string().describe("Content to convert"),
      from: z
        .enum(["storage", "view", "editor", "export_view"])
        .default("storage"),
      to: z
        .enum(["storage", "view", "editor", "export_view"])
        .describe("Target representation"),
    },
    audited(
      "confluence_convert_body",
      getUsername,
      async ({ body, from, to }) => {
        const res = (await client.post("/rest/api/contentbody/convert/" + to, {
          value: body,
          representation: from ?? "storage",
        })) as { value?: string; representation?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { to, representation: res.representation, value: res.value },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  );

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
}
