import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { audited } from "../../audit.js";
import { effectiveProjects } from "../../policy.js";
import {
  assertProjectAllowed,
  makeWriteGuard,
  type JiraCtx,
} from "../jira-common.js";

type Attachment = {
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string };
  content?: string;
};

const TEXT_RE = /^(text\/|application\/(json|xml|javascript|yaml|csv)|image\/svg)/;

async function issueWithAttachments(
  client: AtlassianClient,
  key: string,
): Promise<{ project?: string; attachments: Attachment[] }> {
  const issue = (await client.get(`/rest/api/2/issue/${key}`, {
    fields: "attachment,project",
  })) as {
    fields?: { project?: { key?: string }; attachment?: Attachment[] };
  };
  return {
    project: issue.fields?.project?.key,
    attachments: issue.fields?.attachment ?? [],
  };
}

export function registerJiraAttachmentsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: JiraCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  /**
   * Every attachment op resolves the issue first: scope check on the
   * issue's project AND proof the attachment ID belongs to that issue
   * (Jira's delete/download endpoints take a bare attachment ID — the
   * issue scoping is ours).
   */
  async function scopedIssue(key: string, tool: string) {
    const policy = getPolicy();
    const projects = effectiveProjects(policy, await getUsername());
    const { project, attachments } = await issueWithAttachments(client, key);
    if (project) assertProjectAllowed(projects, project, tool);
    return { project, attachments };
  }

  const shape = (a: Attachment) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    created: a.created,
    author: a.author?.displayName,
    downloadUrl: a.content,
  });

  server.tool(
    "jira_get_attachments",
    "List attachments on an issue — IDs, filenames, sizes, download URLs. The issue's project must be inside your policy scope.",
    {
      key: z.string().describe("Issue key, e.g. SUP-123"),
    },
    audited("jira_get_attachments", getUsername, async ({ key }) => {
      const { attachments } = await scopedIssue(key, "jira_get_attachments");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                key,
                count: attachments.length,
                attachments: attachments.map(shape),
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
    "jira_download_attachment",
    "Download an attachment. Small text files come back inline; anything else needs savePath — a path on the MCP host the file is written to. The issue's project must be inside your policy scope.",
    {
      key: z.string().describe("Issue key — attachment ID is verified against it"),
      attachmentId: z
        .string()
        .describe("Attachment ID — see jira_get_attachments"),
      savePath: z
        .string()
        .optional()
        .describe("Absolute path on the server filesystem to write to"),
    },
    audited(
      "jira_download_attachment",
      getUsername,
      async ({ key, attachmentId, savePath }) => {
        const { attachments } = await scopedIssue(
          key,
          "jira_download_attachment",
        );
        const att = attachments.find((a) => a.id === attachmentId);
        if (!att) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `attachment ${attachmentId} not found on ${key}`,
              },
            ],
          };
        }
        const url =
          att.content ?? `${base}/rest/api/2/attachment/content/${attachmentId}`;
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
                    filename: att.filename,
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
        if (data.length <= 32768 && TEXT_RE.test(mediaType)) {
          return {
            content: [
              {
                type: "text" as const,
                text: data.toString("utf8"),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `binary attachment (${att.filename}, ${data.length} bytes, ${mediaType}) — pass savePath to write it to disk`,
            },
          ],
        };
      },
    ),
  );

  server.tool(
    "jira_add_attachment",
    "Attach a file to an issue — pass a local file path on the MCP host. Only when policy allows writes; the issue's project must be inside your scope.",
    {
      key: z.string().describe("Issue key"),
      filePath: z
        .string()
        .describe("Absolute path to the file on the server filesystem"),
    },
    audited("jira_add_attachment", getUsername, async ({ key, filePath }) => {
      const denied = writeGuard();
      if (denied) return denied;
      try {
        await scopedIssue(key, "jira_add_attachment");
        const created = await client.upload(
          `/rest/api/2/issue/${key}/attachments`,
          filePath,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  uploaded: basename(filePath),
                  bytes: statSync(filePath).size,
                  key,
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
    "jira_delete_attachment",
    "Delete an attachment — the ID is verified against the issue first (Jira's endpoint takes a bare ID; the issue scoping is ours). Only when policy allows writes.",
    {
      key: z.string().describe("Issue key the attachment belongs to"),
      attachmentId: z
        .string()
        .describe("Attachment ID — see jira_get_attachments"),
    },
    audited(
      "jira_delete_attachment",
      getUsername,
      async ({ key, attachmentId }) => {
        const denied = writeGuard();
        if (denied) return denied;
        try {
          const { attachments } = await scopedIssue(
            key,
            "jira_delete_attachment",
          );
          if (!attachments.some((a) => a.id === attachmentId)) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `attachment ${attachmentId} not found on ${key} — refusing to delete`,
                },
              ],
            };
          }
          await client.delete(`/rest/api/2/attachment/${attachmentId}`);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { deleted: attachmentId, issue: key },
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
              {
                type: "text" as const,
                text: e instanceof Error ? e.message : String(e),
              },
            ],
          };
        }
      },
    ),
  );
}
