import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";

/**
 * Per-user credentials, passed through on every request — never stored.
 *
 * Accepted headers:
 *   X-Confluence-PAT: <token>        Confluence DC personal access token
 *   X-Jira-PAT: <token>              Jira DC personal access token
 *   X-Atlassian-PAT: <token>         one PAT valid on both instances
 *                                    (e.g. shared directory behind a gateway)
 *   Authorization: Bearer <token>    fallback for both (same one-PAT case)
 *   Authorization: Basic <b64>       fallback (basic auth, if still enabled)
 *
 * Precedence per service: X-<service>-PAT > X-Atlassian-PAT > Authorization.
 * The X-Atlassian-PAT middle tier exists for MCPHub-style deployments where
 * a single per-user credential slot feeds one shared upstream server.
 */
export type ServiceAuth = {
  confluence?: string;
  jira?: string;
};

export function extractCredentials(req: IncomingMessage): ServiceAuth {
  const h = req.headers;
  const single = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const confluencePat = single(h["x-confluence-pat"])?.trim();
  const jiraPat = single(h["x-jira-pat"])?.trim();
  const sharedPat = single(h["x-atlassian-pat"])?.trim();
  const authz = single(h["authorization"])?.trim();

  const authzFallback =
    authz && /^bearer\s+\S+$/i.test(authz)
      ? `Bearer ${authz.replace(/^bearer\s+/i, "")}`
      : authz && /^basic\s+\S+$/i.test(authz)
        ? `Basic ${authz.replace(/^basic\s+/i, "")}`
        : undefined;
  const shared = sharedPat ? `Bearer ${sharedPat}` : authzFallback;

  return {
    confluence: confluencePat ? `Bearer ${confluencePat}` : shared,
    jira: jiraPat ? `Bearer ${jiraPat}` : shared,
  };
}

/** Stable, non-reversible key for caches — the raw header never becomes a key. */
export function credHash(header: string | undefined): string | null {
  if (!header) return null;
  return createHash("sha256").update(header).digest("hex");
}
