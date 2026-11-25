export type Config = {
  confluenceUrl?: string;
  jiraUrl?: string;
  port: number;
  policyPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    confluenceUrl: stripSlash(env.CONFLUENCE_BASE_URL),
    jiraUrl: stripSlash(env.JIRA_BASE_URL),
    port: Number(env.PORT ?? 3000),
    policyPath: env.POLICY_PATH ?? "./policy.yaml",
  };
  if (!cfg.confluenceUrl && !cfg.jiraUrl) {
    console.error(
      "atlassian-dc-mcp: set CONFLUENCE_BASE_URL and/or JIRA_BASE_URL (e.g. https://confluence.corp.example)",
    );
    process.exit(2);
  }
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    console.error(`atlassian-dc-mcp: invalid PORT '${env.PORT}'`);
    process.exit(2);
  }
  return cfg;
}

function stripSlash(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/+$/, "");
}
