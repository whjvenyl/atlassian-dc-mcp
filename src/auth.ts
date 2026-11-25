import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";

/**
 * Per-user credentials, passed through on every request — never stored.
 *
 * Accepted headers:
 *   X-Confluence-PAT: <token>        Confluence DC personal access token
 *   X-Jira-PAT: <token>              Jira DC personal access token
 *   Authorization: Bearer <token>    fallback for both (works if one PAT is
 *                                  valid on both instances, e.g. crowd/SSO)
 *   Authorization: Basic <b64>       fallback (basic auth, if still enabled)
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
  const authz = single(h["authorization"])?.trim();

  const fallback =
    authz && /^bearer\s+\S+$/i.test(authz)
      ? `Bearer ${authz.replace(/^bearer\s+/i, "")}`
      : authz && /^basic\s+\S+$/i.test(authz)
        ? `Basic ${authz.replace(/^basic\s+/i, "")}`
        : undefined;

  return {
    confluence: confluencePat ? `Bearer ${confluencePat}` : fallback,
    jira: jiraPat ? `Bearer ${jiraPat}` : fallback,
  };
}

/** Stable, non-reversible key for caches — the raw header never becomes a key. */
export function credHash(header: string | undefined): string | null {
  if (!header) return null;
  return createHash("sha256").update(header).digest("hex");
}
