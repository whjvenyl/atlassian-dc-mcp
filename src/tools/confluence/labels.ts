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

export function registerConfluenceLabelsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "confluence_get_labels",
    "Labels on any Confluence content (page, blog, attachment) — the values CQL `label = x` matches against. The content's space must be inside your policy scope.",
    { pageId: z.string().describe("Content ID — page, blog, or attachment" ) },
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
    "Add a label to any Confluence content (page, blog, attachment). Only when policy allows writes; the content's space must be inside your scope.",
    {
      pageId: z.string().describe("Content ID — page, blog, or attachment"),
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
}
