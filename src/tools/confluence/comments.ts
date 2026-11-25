import { randomUUID } from "node:crypto";
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

export function registerConfluenceCommentsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  const commentShape = (c: {
    id: string;
    status?: string;
    ancestors?: { id?: string }[];
    body?: { view?: { value?: string } };
    version?: { by?: { displayName?: string }; when?: string };
    extensions?: {
      location?: string;
      inlineMarkerProperties?: {
        originalSelection?: string;
        textSelection?: string;
      };
      resolution?: { status?: string };
    };
  }) => ({
    id: c.id,
    parentCommentId:
      c.ancestors && c.ancestors.length > 0
        ? c.ancestors[c.ancestors.length - 1].id
        : undefined,
    author: c.version?.by?.displayName,
    at: c.version?.when,
    body: c.body?.view?.value,
    ...(c.extensions?.inlineMarkerProperties
      ? {
          originalSelection:
            c.extensions.inlineMarkerProperties.originalSelection ??
            c.extensions.inlineMarkerProperties.textSelection,
          resolutionStatus: c.extensions.resolution?.status,
        }
      : {}),
  });

  server.tool(
    "confluence_get_comments",
    "List comments on a Confluence page (author, date, body) — footer comments by default, or everything incl. inline & replies with location=all. Refused if the page's space is outside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      location: z
        .enum(["footer", "inline", "all"])
        .default("footer")
        .describe("footer = page-bottom comments; inline = text-anchored; all = both"),
      depth: z
        .enum(["root", "all"])
        .default("root")
        .describe("all includes nested replies"),
      limit: z.number().int().min(1).max(100).default(50),
      start: z.number().int().min(0).default(0),
    },
    audited("confluence_get_comments", getUsername, async ({ pageId, location, depth, limit, start }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      // resolve the parent page's space first — comment list alone doesn't carry it
      const parent = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(parent, spaces, "confluence_get_comments");
      const res = (await client.get(`/rest/api/content/${pageId}/child/comment`, {
        limit,
        start,
        depth,
        ...(location !== "all" ? { location } : {}),
        expand: "body.view,version,container,extensions.inlineProperties,extensions.resolution,ancestors",
      })) as { results?: Parameters<typeof commentShape>[0][] };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                count: res.results?.length ?? 0,
                comments: (res.results ?? []).map(commentShape),
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
    "confluence_get_inline_comments",
    "List inline (text-anchored) comments on a page — includes the anchored text selection and resolution status. Refused if the page's space is outside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    audited("confluence_get_inline_comments", getUsername, async ({ pageId, limit }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const parent = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(parent, spaces, "confluence_get_inline_comments");
      const res = (await client.get(`/rest/api/content/${pageId}/child/comment`, {
        location: "inline",
        depth: "all",
        limit,
        expand: "body.view,version,extensions.inlineProperties,extensions.resolution,ancestors",
      })) as { results?: Parameters<typeof commentShape>[0][] };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                count: res.results?.length ?? 0,
                comments: (res.results ?? []).map(commentShape),
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
    "confluence_reply_to_comment",
    "Reply inside an existing comment thread. Only when policy allows writes; the comment's space must be inside your scope.",
    {
      commentId: z.string().describe("Parent comment ID — see confluence_get_comments"),
      body: z.string().describe("Reply body in storage format (XHTML)"),
    },
    audited("confluence_reply_to_comment", getUsername, async ({ commentId, body }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const parent = (await client.get(`/rest/api/content/${commentId}`, {
          expand: "space,container",
        })) as Page & { container?: { id?: string } };
        checkPageSpace(parent, spaces, "confluence_reply_to_comment");
        const containerId = parent.container?.id;
        if (!containerId) throw new Error("parent comment has no container");
        const created = (await client.post("/rest/api/content", {
          type: "comment",
          container: { id: containerId },
          ancestors: [{ id: commentId }],
          body: { storage: { value: body, representation: "storage" } },
        })) as Page;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { replied: commentId, id: created.id },
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
    "confluence_add_inline_comment",
    "Add an inline comment anchored to text on a page — the exact text must appear in the page body. Only when policy allows writes; page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      body: z.string().describe("Comment body in storage format (XHTML)"),
      textSelection: z
        .string()
        .describe("Exact text on the page to anchor to — must exist verbatim"),
      textSelectionMatchCount: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("How many times the text appears on the page"),
      textSelectionMatchIndex: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based index of the occurrence to anchor to"),
    },
    audited("confluence_add_inline_comment", getUsername, async ({ pageId, body, textSelection, textSelectionMatchCount, textSelectionMatchIndex }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const parent = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(parent, spaces, "confluence_add_inline_comment");
        const created = (await client.post("/rest/api/content", {
          type: "comment",
          container: { id: pageId },
          body: { storage: { value: body, representation: "storage" } },
          extensions: {
            location: "inline",
            inlineMarkerProperties: {
              textSelection,
              textSelectionMatchCount,
              textSelectionMatchIndex,
              inlineMarkerRef: randomUUID(),
            },
          },
        })) as Page;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { commented: pageId, id: created.id, anchoredTo: textSelection },
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
