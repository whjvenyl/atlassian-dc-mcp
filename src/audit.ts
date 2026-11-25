/**
 * Audit logging — one JSON line per tool call on stderr.
 * Inspired by the official Rovo MCP's org audit log: a shared deployment
 * needs to answer "who called what, was it allowed, how long did it take".
 *
 * Fields: ts, tool, user (resolved Atlassian username or "unknown"),
 * denied (server-policy refusal, not upstream errors), ms.
 * Credentials are never logged.
 */
export function auditLog(entry: {
  tool: string;
  user: string | null;
  denied?: boolean;
  ms: number;
}) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      audit: true,
      tool: entry.tool,
      user: entry.user ?? "unknown",
      denied: entry.denied === true,
      ms: Math.round(entry.ms),
    }),
  );
}

function isDenial(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Policy denies");
}

function isDeniedResult(res: unknown): boolean {
  if (
    typeof res === "object" &&
    res !== null &&
    (res as { isError?: boolean }).isError === true
  ) {
    const content = (res as { content?: { type: string; text?: string }[] })
      .content;
    const text = (content ?? [])
      .map((c) => c.text ?? "")
      .join(" ");
    return /policy|writes are disabled/i.test(text);
  }
  return false;
}

type ToolResult = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
};

/**
 * Wrap a tool handler: time it, resolve the caller identity (cached),
 * flag policy denials, emit one audit line. Never lets auditing break
 * the tool call itself.
 */
export function audited<A, R extends ToolResult>(
  tool: string,
  getUsername: () => Promise<string | null>,
  handler: (args: A) => Promise<R>,
): (args: A) => Promise<R> {
  return async (args) => {
    const t0 = Date.now();
    let denied = false;
    try {
      const res = await handler(args);
      denied = isDeniedResult(res);
      return res;
    } catch (e) {
      denied = isDenial(e);
      throw e;
    } finally {
      try {
        const user = await getUsername();
        auditLog({ tool, user, denied, ms: Date.now() - t0 });
      } catch {
        /* audit must never break a tool call */
      }
    }
  };
}
