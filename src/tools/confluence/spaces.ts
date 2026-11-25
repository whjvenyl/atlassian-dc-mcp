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

export function registerConfluenceSpacesTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

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
}
