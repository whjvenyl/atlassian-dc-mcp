import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Named tool groups using the familiar Atlassian-MCP toolset names so
 * configs transfer as the tool surface grows.
 */
export const TOOLSETS: Record<string, readonly string[]> = {
  jira_issues: [
    "jira_get_issue",
    "jira_search",
    "jira_create_issue",
    "jira_update_issue",
    "jira_assign_issue",
  ],
  jira_comments: [
    "jira_add_comment",
    "jira_get_comments",
    "jira_edit_comment",
  ],
  jira_transitions: ["jira_get_transitions", "jira_transition_issue"],
  jira_projects: ["jira_list_projects"],
  jira_users: [
    "jira_myself",
    "jira_search_assignable_users",
    "jira_get_user_profile",
  ],
  jira_watchers: [
    "jira_get_issue_watchers",
    "jira_add_issue_watcher",
    "jira_remove_issue_watcher",
  ],
  jira_changelog: ["jira_get_changelog"],
  jira_worklogs: ["jira_get_worklogs", "jira_add_worklog"],
  jira_fields: [
    "jira_search_fields",
    "jira_get_project_issue_types",
    "jira_get_create_fields",
    "jira_get_field_options",
  ],
  confluence_pages: [
    "confluence_search",
    "confluence_get_page",
    "confluence_get_page_children",
    "confluence_get_page_history",
    "confluence_create_page",
    "confluence_update_page",
    "confluence_delete_page",
    "confluence_move_page",
    "confluence_copy_page",
  ],
  confluence_labels: ["confluence_get_labels", "confluence_add_label"],
  confluence_comments: [
    "confluence_get_comments",
    "confluence_add_comment",
    "confluence_reply_to_comment",
    "confluence_get_inline_comments",
    "confluence_add_inline_comment",
  ],
  confluence_permissions: [
    "confluence_get_page_restrictions",
    "confluence_update_page_restrictions",
  ],
  confluence_spaces: ["confluence_list_spaces", "confluence_get_space_detail", "confluence_get_space_content"],
  confluence_users: ["confluence_current_user", "confluence_search_users"],
};

/** Always-on baseline when TOOLSETS=default — mirrors their core set. */
export const CORE_TOOLSETS = new Set([
  "jira_issues",
  "jira_comments",
  "jira_transitions",
  "jira_fields",
  "confluence_pages",
  "confluence_comments",
]);

/**
 * Resolve a TOOLSETS value to the concrete tool-name set it enables.
 * `default` → core toolsets; `all` → every toolset; unknown names are
 * ignored (all-unknown → empty set = fail closed).
 */
export function resolveToolsets(names: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    if (name === "default") {
      for (const ts of CORE_TOOLSETS)
        for (const t of TOOLSETS[ts] ?? []) out.add(t);
    } else if (name === "all") {
      for (const ts of Object.keys(TOOLSETS))
        for (const t of TOOLSETS[ts]) out.add(t);
    } else {
      for (const t of TOOLSETS[name] ?? []) out.add(t);
    }
  }
  return out;
}

/**
 * Registration filter: tools outside the allowlist are never registered,
 * so they are absent from tools/list AND uncallable by name — structural
 * enforcement (nothing to bypass): absent from tools/list AND uncallable.
 * ENABLED_TOOLS and TOOLSETS intersect.
 */
export function toolFilter(
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
