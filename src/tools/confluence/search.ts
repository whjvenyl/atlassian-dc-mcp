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

export function registerConfluenceSearchTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

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
}
