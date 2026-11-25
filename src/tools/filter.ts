import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ENABLED_TOOLS allowlist: tools not in the set are never registered, so
 * they are absent from tools/list AND uncallable by name — structural
 * enforcement (nothing to bypass), matching mcp-atlassian's
 * list+call-time semantics.
 */
export function enabledToolFilter(
  server: McpServer,
  enabled: Set<string> | undefined,
): McpServer {
  if (!enabled) return server;
  return new Proxy(server, {
    get(obj, prop, recv) {
      if (prop === "tool") {
        return (...args: unknown[]) => {
          if (!enabled.has(args[0] as string)) return undefined;
          return (obj.tool as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(obj, prop, recv);
    },
  }) as McpServer;
}
