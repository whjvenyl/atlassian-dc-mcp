import { defineConfig } from "blume";

export default defineConfig({
  title: "atlassian-dc-mcp",
  description:
    "Policy-scoped MCP server for self-hosted Confluence & Jira Data Center — per-user PATs, admin-enforced scoping, shared deployment ready.",

  logo: "/logo.svg",

  github: {
    owner: "whjvenyl",
    repo: "atlassian-dc-mcp",
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
                "/tools/jira-issues",
                "/tools/jira-search",
                "/tools/jira-comments",
                "/tools/jira-meta",
              ],
            },
            {
              label: "Confluence tools",
              items: ["/tools/confluence-search", "/tools/confluence-pages"],
            },
          ],
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
