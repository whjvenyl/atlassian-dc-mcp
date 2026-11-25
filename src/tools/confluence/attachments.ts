import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { audited } from "../../audit.js";
import { effectiveSpaces } from "../../policy.js";
import {
  checkPageSpace,
  makeWriteGuard,
  type ConfluenceCtx,
  type Page,
} from "../confluence-common.js";

export function registerConfluenceAttachmentsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  const attachmentShape = (a: {
    id?: string;
    title?: string;
    type?: string;
    _links?: { download?: string };
    metadata?: { mediaType?: string };
    extensions?: { mediaType?: string; fileSize?: number };
  }) => ({
    id: a.id,
    title: a.title,
    mediaType: a.extensions?.mediaType ?? a.metadata?.mediaType,
    fileSize: a.extensions?.fileSize,
    downloadUrl: a._links?.download ? `${base}${a._links.download}` : undefined,
  });

  server.tool(
    "confluence_get_attachments",
    "List attachments on a Confluence page. The page's space must be inside your policy scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      limit: z.number().int().min(1).max(100).default(25),
      filename: z.string().optional().describe("Filter to an exact filename"),
    },
    audited("confluence_get_attachments", getUsername, async ({ pageId, limit, filename }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const page = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(page, spaces, "confluence_get_attachments");
      const res = (await client.get(`/rest/api/content/${pageId}/child/attachment`, {
        limit,
        ...(filename ? { filename } : {}),
        expand: "metadata",
      })) as { results?: Parameters<typeof attachmentShape>[0][] };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                count: res.results?.length ?? 0,
                attachments: (res.results ?? []).map(attachmentShape),
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
    "confluence_get_attachment",
    "Fetch one attachment's metadata + download URL by content ID (e.g. 'att123456'). The owning space must be inside your policy scope.",
    {
      attachmentId: z
        .string()
        .describe("Attachment content ID, e.g. 'att123456' — see confluence_get_attachments"),
    },
    audited("confluence_get_attachment", getUsername, async ({ attachmentId }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const res = (await client.get(`/rest/api/content/${attachmentId}`, {
        expand: "space,metadata",
      })) as Page & {
        metadata?: { mediaType?: string };
        extensions?: { fileSize?: number };
      };
      checkPageSpace(res, spaces, "confluence_get_attachment");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              attachmentShape({
                id: res.id,
                title: res.title,
                _links: { download: (res._links as { download?: string })?.download },
                extensions: res.extensions,
                metadata: res.metadata,
              }),
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  server.tool(
    "confluence_download_attachment",
    "Download an attachment by content ID ('att123456'). Small text files come back inline; anything else needs savePath — a path on the MCP host. The owning space must be inside your policy scope.",
    {
      attachmentId: z
        .string()
        .describe("Attachment content ID — see confluence_get_attachments"),
      savePath: z
        .string()
        .optional()
        .describe("Absolute path on the server filesystem to write to"),
    },
    audited(
      "confluence_download_attachment",
      getUsername,
      async ({ attachmentId, savePath }) => {
        const policy = getPolicy();
        const spaces = effectiveSpaces(policy, await getUsername());
        const meta = (await client.get(`/rest/api/content/${attachmentId}`, {
          expand: "space",
        })) as Page & {
          _links?: { download?: string };
          container?: { id?: string };
        };
        checkPageSpace(meta, spaces, "confluence_download_attachment");
        const download = meta._links?.download;
        const url = download
          ? `${base}${download}`
          : `${base}/download/attachments/${meta.container?.id ?? ""}/${encodeURIComponent(meta.title ?? "")}`;
        const { data, mediaType } = await client.getBinary(url);
        if (savePath) {
          mkdirSync(dirname(savePath), { recursive: true });
          writeFileSync(savePath, data);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    saved: savePath,
                    filename: meta.title,
                    bytes: data.length,
                    mediaType,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const TEXT_RE = /^(text\/|application\/(json|xml|javascript|yaml|csv)|image\/svg)/;
        if (data.length <= 32768 && TEXT_RE.test(mediaType)) {
          return {
            content: [{ type: "text" as const, text: data.toString("utf8") }],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `binary attachment (${meta.title}, ${data.length} bytes, ${mediaType}) — pass savePath to write it to disk`,
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "confluence_add_attachment",
    "Upload a file to a page as an attachment — pass a local file path on the MCP host. Only when policy allows writes; page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      filePath: z
        .string()
        .describe("Absolute path to the file on the server filesystem"),
      comment: z.string().optional().describe("Attachment comment"),
    },
    audited("confluence_add_attachment", getUsername, async ({ pageId, filePath, comment }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(page, spaces, "confluence_add_attachment");
        const created = await client.upload(
          `/rest/api/content/${pageId}/child/attachment`,
          filePath,
          comment,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  uploaded: basename(filePath),
                  bytes: statSync(filePath).size,
                  pageId,
                  result: created,
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
}
