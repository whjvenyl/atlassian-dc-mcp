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
    "List Confluence spaces you may see under the server policy (global cap ∩ your rules ∩ your PAT's DC permissions). Archived spaces are included and flagged — the API hides them by default.",
    {
      limit: z.number().int().min(1).max(200).default(50),
      status: z
        .enum(["current", "archived", "all"])
        .default("all")
        .describe("Space status — 'all' includes archived spaces the API hides by default"),
      type: z
        .enum(["global", "personal", "all"])
        .default("all")
        .describe("Space type — 'all' includes personal (~user) spaces"),
    },
    audited(
      "confluence_list_spaces",
      getUsername,
      async ({ limit, status, type }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      denyIfEmpty(spaces, "confluence_list_spaces");
      // The API's status default drops archived spaces, and neither
      // status nor type has an 'all' value — fetch the cartesian
      // product and merge by key so "in policy but count 0" can't
      // mean "hidden by an API default".
      const fetchSpaces = (st: string, ty: string) =>
        client.get("/rest/api/space", {
          limit: spaces ? Math.min(limit * 3, 200) : limit,
          status: st,
          type: ty,
        }) as Promise<{
          results?: { key: string; name: string; type: string; status?: string }[];
        }>;
      const statuses = status === "all" ? ["current", "archived"] : [status];
      const types = type === "all" ? ["global", "personal"] : [type];
      const lists = await Promise.all(
        statuses.flatMap((st) => types.map((ty) => fetchSpaces(st, ty))),
      );
      const seen = new Set<string>();
      const merged = lists
        .flatMap((r) => r.results ?? [])
        .filter((s) => !seen.has(s.key) && (seen.add(s.key), true));
      const filtered = merged.filter(
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
                spaces: filtered.map((s) => ({
                  ...s,
                  status: s.status ?? "current",
                })),
                // flag policy entries the PAT can't reach at all
                unreachable:
                  spaces?.filter(
                    (k) => !filtered.some((s) => s.key === k),
                  ) ?? undefined,
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
