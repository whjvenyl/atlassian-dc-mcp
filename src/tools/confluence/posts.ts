import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { audited } from "../../audit.js";
import { effectiveSpaces } from "../../policy.js";
import {
  assertSpaceAllowed,
  checkPageSpace,
  makeWriteGuard,
  pageSummary,
  type ConfluenceCtx,
  type Page,
} from "../confluence-common.js";

export function registerConfluencePostsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "confluence_get_ancestors",
    "Breadcrumb trail to a page — root → parent → … → this page. The page's space must be inside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
    },
    audited("confluence_get_ancestors", getUsername, async ({ pageId }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const page = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space,ancestors",
      })) as Page;
      checkPageSpace(page, spaces, "confluence_get_ancestors");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                ancestors: (page.ancestors ?? []).map((a) => ({
                  id: a.id,
                  // ancestors carry title only when expanded
                  ...("title" in a ? { title: (a as { title?: string }).title } : {}),
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
    "confluence_get_blog_posts",
    "List blog posts in a space — Confluence's changelog feed. The space must be inside your policy scope.",
    {
      space: z.string().describe("Space key"),
      limit: z.number().int().min(1).max(100).default(25),
      start: z.number().int().min(0).default(0),
    },
    audited("confluence_get_blog_posts", getUsername, async ({ space, limit, start }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      assertSpaceAllowed(spaces, space, "confluence_get_blog_posts");
      const res = (await client.get("/rest/api/content", {
        spaceKey: space,
        type: "blogpost",
        limit,
        start,
        expand: "version,space",
      })) as { results?: Page[]; size?: number };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                space,
                count: res.size ?? res.results?.length ?? 0,
                posts: (res.results ?? []).map((p) => pageSummary(p, base)),
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
    "confluence_create_blog_post",
    "Publish a blog post in a space. Only when policy allows writes; the space must be inside your scope.",
    {
      space: z.string().describe("Space key"),
      title: z.string().describe("Post title"),
      body: z.string().describe("Body in storage format (XHTML)"),
    },
    audited("confluence_create_blog_post", getUsername, async ({ space, title, body }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        assertSpaceAllowed(spaces, space, "confluence_create_blog_post");
        const created = (await client.post("/rest/api/content", {
          type: "blogpost",
          title,
          space: { key: space },
          body: { storage: { value: body, representation: "storage" } },
        })) as Page;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(pageSummary(created, base), null, 2),
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
