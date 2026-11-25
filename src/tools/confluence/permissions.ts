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

export function registerConfluencePermissionsTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  const restrictionShape = (r: {
    restrictions?: {
      user?: { results?: { displayName?: string; username?: string }[] };
      group?: { results?: { name?: string }[] };
    };
  }) => ({
    users: (r.restrictions?.user?.results ?? []).map(
      (u) => u.username ?? u.displayName,
    ),
    groups: (r.restrictions?.group?.results ?? []).map((g) => g.name),
  });

  server.tool(
    "confluence_get_page_restrictions",
    "Show read/edit restrictions on a page — who can view or edit beyond space-level access. Page's space must be inside your policy scope.",
    { pageId: z.string().describe("Numeric page ID") },
    audited("confluence_get_page_restrictions", getUsername, async ({ pageId }) => {
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      const page = (await client.get(`/rest/api/content/${pageId}`, {
        expand: "space",
      })) as Page;
      checkPageSpace(page, spaces, "confluence_get_page_restrictions");
      const res = (await client.get(`/rest/api/content/${pageId}/restriction`, {
        expand: "restrictions.user.results,restrictions.group.results",
      })) as {
        read?: Parameters<typeof restrictionShape>[0];
        update?: Parameters<typeof restrictionShape>[0];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId,
                read: res.read ? restrictionShape(res.read) : { users: [], groups: [] },
                update: res.update ? restrictionShape(res.update) : { users: [], groups: [] },
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
    "confluence_update_page_restrictions",
    "Set read/edit restrictions on a page — replaces the full set for that operation. Only when policy allows writes; page's space must be inside your scope.",
    {
      pageId: z.string().describe("Numeric page ID"),
      operation: z
        .enum(["read", "update"])
        .describe("read = who can view; update = who can edit"),
      users: z
        .array(z.string())
        .optional()
        .describe("Usernames to allow — empty with groups removes the restriction"),
      groups: z
        .array(z.string())
        .optional()
        .describe("Group names to allow"),
    },
    audited("confluence_update_page_restrictions", getUsername, async ({ pageId, operation, users, groups }) => {
      const denied = writeGuard();
      if (denied) return denied;
      const policy = getPolicy();
      const spaces = effectiveSpaces(policy, await getUsername());
      try {
        const page = (await client.get(`/rest/api/content/${pageId}`, {
          expand: "space",
        })) as Page;
        checkPageSpace(page, spaces, "confluence_update_page_restrictions");
        await client.put(`/rest/api/content/${pageId}/restriction`, [
          {
            operation,
            restrictions: {
              user: (users ?? []).map((u) => ({ username: u })),
              group: (groups ?? []).map((name) => ({ name })),
            },
          },
        ]);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { pageId, operation, users: users ?? [], groups: groups ?? [] },
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
