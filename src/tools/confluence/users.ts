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

export function registerConfluenceUsersTools({
  server,
  client,
  base,
  getPolicy,
  getUsername,
}: ConfluenceCtx): void {
  const writeGuard = makeWriteGuard(getPolicy);

  server.tool(
    "confluence_server_info",
    "Confluence instance version and build — check this before relying on version-specific REST behavior. Unscoped: instance metadata, no space cap.",
    {},
    audited("confluence_server_info", getUsername, async () => {
      // /rest/api/settings/systemInfo exists on DC 7.13+; falls back to
      // a space probe for older builds where it may be absent.
      try {
        const res = (await client.get("/rest/api/settings/systemInfo")) as {
          version?: string;
          buildNumber?: string | number;
          baseUrl?: string;
          defaultLocale?: string;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  baseUrl: res.baseUrl ?? base,
                  version: res.version,
                  buildNumber: res.buildNumber,
                  defaultLocale: res.defaultLocale,
                  restApi: "/rest/api",
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
              text:
                `systemInfo unavailable (${e instanceof Error ? e.message : String(e)}) — ` +
                `instance may be older than Confluence DC 7.13`,
            },
          ],
        };
      }
    }),
  );

  server.tool(
    "confluence_current_user",
    "Return the Atlassian identity your PAT resolves to on Confluence — the same identity per-user policy rules key on.",
    {},
    audited("confluence_current_user", getUsername, async () => {
      const me = (await client.get("/rest/api/user/current")) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username: me.username,
                userKey: me.userKey,
                displayName: me.displayName,
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
    "confluence_search_users",
    "Find Confluence users by name — DC `/rest/api/search/user` CQL. Useful before assigning comments or tracking authors.",
    {
      query: z.string().describe("Name or username substring"),
      limit: z.number().int().min(1).max(50).default(10),
    },
    audited("confluence_search_users", getUsername, async ({ query, limit }) => {
      const res = (await client.get("/rest/api/search/user", {
        cql: `type=user AND user.fullname ~ "${query.replace(/"/g, '\\"')}"`,
        limit,
      })) as {
        results?: {
          user?: { username?: string; displayName?: string };
        }[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                users: (res.results ?? []).map((r) => ({
                  username: r.user?.username,
                  displayName: r.user?.displayName,
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
}
