import { defineConfig } from "blume";
import { openapi } from "blume/reference";

export default defineConfig({
  title: "atlassian-dc-mcp",
  description:
    "Policy-scoped MCP server for self-hosted Confluence & Jira Data Center — per-user PATs, admin-enforced scoping, shared deployment ready.",

  logo: "/logo.svg",

  github: {
    owner: "whjvenyl",
    repo: "atlassian-dc-mcp",
    // content lives in site/ — without this "Edit on GitHub" links 404
    dir: "site",
  },

  reference: [
    openapi({
      sources: [
        {
          label: "Jira DC 11.2",
          route: "/api/jira",
          spec: "./specs/jira-dc-11.2.json",
          overlays: ["./specs/overlays/jira.yaml"],
          includeInLlms: false,
        },
        {
          label: "Confluence DC 9.2",
          route: "/api/confluence",
          spec: "./specs/confluence-dc-9.2.json",
          overlays: ["./specs/overlays/confluence.yaml"],
          includeInLlms: false,
        },
      ],
      codeSamples: ["curl", "js", "python"],
    }),
  ],

  agents: {
    llmsTxt: {
      // ~400 generated reference pages would swamp the curated index;
      // they're reachable via site search and their own sidebars instead.
      openapi: false,
      details:
        "Use atlassian-dc-mcp when an MCP client (Claude Code, Cursor, MCPHub…) needs to read or write self-hosted Confluence or Jira **Data Center** — the official Atlassian MCP server is Cloud-only. It is a Streamable-HTTP MCP server: users send their own PAT per request (`X-Atlassian-PAT`, or split `X-Confluence-PAT`/`X-Jira-PAT`), and a server-side `policy.yaml` caps the spaces/projects/write access any token can reach. Install with `npm install -g atlassian-dc-mcp`, `docker pull ghcr.io/whjvenyl/atlassian-dc-mcp`, or a platform binary from GitHub Releases; it listens on :3000 (`/mcp`, `/healthz`). Tool breadth: Jira issues/transitions/search/comments/worklogs/links/versions/attachments/agile (boards, sprints, epics, backlog, ranking)/filters/lookup metadata, and Confluence spaces/pages/comments/labels/attachments/permissions/posts — 93 tools, filterable by `ENABLED_TOOLS` and `TOOLSETS` env.",
    },
  },

  navigation: {
    sidebar: {
      display: "flat",
      items: [
        "/",
        {
          label: "Get started",
          items: ["/quickstart", "/guides/installation", "/configuration"],
        },
        {
          label: "Usage",
          items: [
            "/guides",
            "/guides/workflows",
            "/guides/cql",
            "/guides/jql",
          ],
        },
        {
          label: "Deploying",
          items: ["/mcphub", "/shared", "/policy", "/authentication"],
        },
        {
          label: "Tools",
          root: "/tools",
          items: [
            {
              label: "Jira tools",
              items: [
                "/tools/jira-issues-transitions",
                "/tools/jira-search-fields",
                "/tools/jira-comments-worklogs",
                "/tools/jira-links-versions",
                "/tools/jira-attachments",
                "/tools/jira-agile",
                "/tools/jira-meta",
              ],
            },
            {
              label: "Confluence tools",
              items: [
                "/tools/confluence-search",
                "/tools/confluence-spaces",
                "/tools/confluence-pages",
                "/tools/confluence-comments",
                "/tools/confluence-attachments",
                "/tools/confluence-permissions",
                "/tools/confluence-posts",
              ],
            },
          ],
        },
        {
          label: "API reference",
          items: ["/api/jira", "/api/confluence"],
        },
        {
          label: "Help",
          items: ["/troubleshooting"],
        },
      ],
    },
    actions: [
      {
        label: "Releases",
        href: "https://github.com/whjvenyl/atlassian-dc-mcp/releases",
      },
    ],
    cta: {
      label: "GitHub",
      href: "https://github.com/whjvenyl/atlassian-dc-mcp",
    },
  },

  theme: {
    accent: "teal",
    radius: "lg",
    mode: "system",
  },

  deployment: {
    site: "https://whjvenyl.github.io",
    base: "/atlassian-dc-mcp",
  },

  footer: {
    copyright: `© ${new Date().getFullYear()} whjvenyl`,
    links: [
      { label: "npm", href: "https://www.npmjs.com/package/atlassian-dc-mcp" },
      {
        label: "GitHub",
        href: "https://github.com/whjvenyl/atlassian-dc-mcp",
      },
    ],
  },

  lastModified: "git",
});
