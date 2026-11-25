import { defineConfig } from "blume";

export default defineConfig({
  title: "atlassian-dc-mcp",
  description:
    "Policy-scoped MCP server for self-hosted Confluence & Jira Data Center — per-user PATs, admin-enforced scoping, shared deployment ready.",

  github: {
    owner: "whjvenyl",
    repo: "atlassian-dc-mcp",
  },

  theme: {
    accent: "blue",
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
