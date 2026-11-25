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
  const server = new McpServer(
    { name: "atlassian-dc-mcp", version: "0.1.0" },
    {
      instructions:
        "Self-hosted Atlassian access via per-user PAT. Server policy may " +
        "restrict which Confluence spaces and Jira projects you can reach; " +
        "your effective scope is the intersection of your PAT's DC " +
        "permissions and that policy, and cannot be widened from the client.",
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
