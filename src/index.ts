#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { loadPolicy, reloadIfChanged, type Policy } from "./policy.js";
import { extractCredentials } from "./auth.js";
import { AtlassianClient, resolveIdentity } from "./client.js";
import { registerConfluenceTools } from "./tools/confluence.js";
import { registerJiraTools } from "./tools/jira.js";

const config = loadConfig();

let policyState = {
  policy: loadPolicy(config.policyPath),
  mtimeMs: (() => {
    try {
      return statSync(config.policyPath).mtimeMs;
    } catch {
      return 0;
    }
  })(),
};

/** Reload-on-change policy so an admin can update caps without restart. */
function currentPolicy(): Policy {
  policyState = reloadIfChanged(config.policyPath, policyState);
  return policyState.policy;
}

/**
 * One McpServer + transport per HTTP request (stateless mode): credentials
 * come from request headers, so nothing user-specific may be shared between
 * requests or sessions.
 */
function buildServer(req: IncomingMessage): McpServer {
  const creds = extractCredentials(req);
  // version kept in sync with package.json manually — reading package.json
  // at runtime would break bun-compiled standalone binaries (no fs file)
  const server = new McpServer(
    { name: "atlassian-dc-mcp", version: "0.2.2" },
    {
      instructions:
        "Self-hosted Confluence/Jira Data Center access via per-user PAT.\n\n" +
        "SCOPE MODEL: a server-side policy caps which spaces/projects are " +
        "reachable. Your effective scope = your PAT's DC permissions ∩ the " +
        "server policy — it cannot be widened from the client, and search " +
        "CQL/JQL is automatically AND-ed with the allowlist.\n\n" +
        "WORKFLOW:\n" +
        "1. Call confluence_list_spaces / jira_list_projects FIRST to see " +
        "your effective scope before searching.\n" +
        "2. Search with confluence_search (CQL) / jira_search (JQL) — the " +
        "returned 'effectiveCQL'/'effectiveJQL' shows the scope injected.\n" +
        "3. Fetch details with confluence_get_page / jira_get_issue — " +
        "refused if outside your scope; the error names your allowed list.\n\n" +
        "WRITES (only when server policy allows): create/update pages & " +
        "comments (confluence_*), create/update/transition/comment issues " +
        "(jira_*). For a status change, call jira_get_transitions first and " +
        "pass the transition name — never guess one. Writes to a " +
        "space/project outside your scope are refused the same way.\n\n" +
        "If a call is policy-denied, tell the user their MCP policy needs " +
        "widening (admin-side policy.yaml) — do NOT retry with tweaked " +
        "queries hoping to bypass it; the cap is enforced server-side.",
    },
  );

  if (config.confluenceUrl && creds.confluence) {
    const client = new AtlassianClient(config.confluenceUrl, creds.confluence);
    registerConfluenceTools(
      server,
      client,
      config.confluenceUrl,
      currentPolicy,
      () => resolveIdentity(client, creds.confluence!),
    );
  }
  if (config.jiraUrl && creds.jira) {
    const client = new AtlassianClient(config.jiraUrl, creds.jira);
    registerJiraTools(
      server,
      client,
      config.jiraUrl,
      currentPolicy,
      () => resolveIdentity(client, creds.jira!),
    );
  }
  return server;
}

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404).end("not found");
    return;
  }

  const creds = extractCredentials(req);
  if (!creds.confluence && !creds.jira) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "Provide a PAT: X-Confluence-PAT and/or X-Jira-PAT header " +
          "(or Authorization: Bearer <pat> if one PAT covers both).",
      }),
    );
    return;
  }

  // Stateless transport: no session tracking, no shared state between users.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer(req);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent)
      res.writeHead(500).end("internal error");
  }
});

http.listen(config.port, () => {
  const services = [
    config.confluenceUrl ? `confluence=${config.confluenceUrl}` : null,
    config.jiraUrl ? `jira=${config.jiraUrl}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  console.error(
    `atlassian-dc-mcp listening on :${config.port} — POST /mcp  [${services}]`,
  );
});
