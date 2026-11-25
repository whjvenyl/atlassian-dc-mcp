import { credHash } from "./auth.js";

/**
 * Self-signed CA support: set NODE_EXTRA_CA_CERTS=/path/to/ca.pem before
 * starting the server (Node reads it once at boot).
 */

type Params = Record<string, string | number | boolean | undefined>;

export class AtlassianClient {
  constructor(
    private baseUrl: string,
    private authHeader: string,
  ) {}

  async get(path: string, params?: Params): Promise<unknown> {
    return this.req("GET", path, params);
  }

  async post(path: string, body: unknown, params?: Params): Promise<unknown> {
    return this.req("POST", path, params, body);
  }

  async put(path: string, body: unknown, params?: Params): Promise<unknown> {
    return this.req("PUT", path, params, body);
  }

  private async req(
    method: string,
    path: string,
    params?: Params,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = JSON.parse(text) as {
          message?: string;
          errorMessages?: string[];
          errors?: Record<string, string>;
        };
        if (j.message) msg = j.message;
        else if (j.errorMessages?.length) msg = j.errorMessages.join("; ");
        else if (j.errors) msg = `${msg} ${JSON.stringify(j.errors)}`;
      } catch {
        if (text) msg = `${msg} — ${text.slice(0, 300)}`;
      }
      throw new Error(
        `${method} ${url.pathname} failed: ${msg}`,
      );
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

const IDENTITY_TTL_MS = 5 * 60 * 1000;
const identityCache = new Map<string, { name: string; exp: number }>();

/**
 * Resolve the caller's Atlassian username from their own credential.
 * Used to apply per-user policy rules — never trusts a client-supplied
 * identity header (spoofable). Cached for 5 min keyed by a hash of the
 * credential, not the credential itself.
 */
export async function resolveIdentity(
  client: AtlassianClient,
  credHeader: string,
): Promise<string | null> {
  const key = credHash(credHeader)!;
  const hit = identityCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.name;
  try {
    // Works on both Confluence and Jira DC.
    const me = (await client.get("/rest/api/user/current")) as {
      name?: string;
      key?: string;
      displayName?: string;
    };
    const name = me.name ?? me.key ?? me.displayName ?? null;
    if (name)
      identityCache.set(key, { name, exp: Date.now() + IDENTITY_TTL_MS });
    return name;
  } catch {
    try {
      // Jira-flavoured fallback.
      const me = (await client.get("/rest/api/2/myself")) as {
        name?: string;
        key?: string;
      };
      const name = me.name ?? me.key ?? null;
      if (name)
        identityCache.set(key, { name, exp: Date.now() + IDENTITY_TTL_MS });
      return name;
    } catch {
      return null;
    }
  }
}
