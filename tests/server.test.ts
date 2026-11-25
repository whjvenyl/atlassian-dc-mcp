import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AtlassianClient } from "../src/client.js";
import { emptyPolicy, type Policy } from "../src/policy.js";
import { registerConfluenceTools } from "../src/tools/confluence.js";
import { registerJiraTools } from "../src/tools/jira.js";
import { resolveToolsets, toolFilter } from "../src/tools/filter.js";

// Registration smoke: correct tools appear per configured service.
// McpServer doesn't expose a public listTools accessor; reach into the
// registered tool map the SDK keeps on the instance.
function toolNames(server: McpServer): string[] {
  const internal = server as unknown as {
    _registeredTools?: Record<string, unknown>;
  };
  return Object.keys(internal._registeredTools ?? {}).sort();
}

function fakeClient(): AtlassianClient {
  return new AtlassianClient("https://dc.example", "Bearer x");
}

const getPolicy = (): Policy => emptyPolicy();
const getUsername = async () => "alice";

test("confluence tools register", () => {
  const s = new McpServer({ name: "t", version: "0" });
  registerConfluenceTools(s, fakeClient(), "https://dc.example", getPolicy, getUsername);
  assert.deepEqual(toolNames(s), [
    "confluence_add_comment",
    "confluence_add_label",
    "confluence_copy_page",
    "confluence_create_page",
    "confluence_current_user",
    "confluence_delete_page",
    "confluence_get_comments",
    "confluence_get_labels",
    "confluence_get_page",
    "confluence_get_page_children",
    "confluence_get_page_history",
    "confluence_get_space_content",
    "confluence_get_space_detail",
    "confluence_list_spaces",
    "confluence_move_page",
    "confluence_search",
    "confluence_search_users",
    "confluence_update_page",
  ]);
});

test("jira tools register", () => {
  const s = new McpServer({ name: "t", version: "0" });
  registerJiraTools(s, fakeClient(), "https://dc.example", getPolicy, getUsername);
  assert.deepEqual(toolNames(s), [
    "jira_add_comment",
    "jira_add_issue_watcher",
    "jira_add_worklog",
    "jira_assign_issue",
    "jira_create_issue",
    "jira_edit_comment",
    "jira_get_changelog",
    "jira_get_comments",
    "jira_get_create_fields",
    "jira_get_field_options",
    "jira_get_issue",
    "jira_get_issue_watchers",
    "jira_get_project_issue_types",
    "jira_get_transitions",
    "jira_get_user_profile",
    "jira_get_worklogs",
    "jira_list_projects",
    "jira_myself",
    "jira_remove_issue_watcher",
    "jira_search",
    "jira_search_assignable_users",
    "jira_search_fields",
    "jira_transition_issue",
    "jira_update_issue",
  ]);
});

test("ENABLED_TOOLS filters registration", () => {
  const s = new McpServer({ name: "t", version: "0" });
  const enabled = new Set(["jira_search", "jira_get_issue"]);
  registerJiraTools(
    toolFilter(s, enabled),
    fakeClient(),
    "https://dc.example",
    getPolicy,
    getUsername,
  );
  assert.deepEqual(toolNames(s), ["jira_get_issue", "jira_search"]);
});

test("no ENABLED_TOOLS registers everything", () => {
  const s = new McpServer({ name: "t", version: "0" });
  registerJiraTools(
    toolFilter(s, undefined),
    fakeClient(),
    "https://dc.example",
    getPolicy,
    getUsername,
  );
  assert.equal(toolNames(s).length, 24);
});

test("TOOLSETS=default enables only core tools", () => {
  const enabled = resolveToolsets(new Set(["default"]));
  assert.ok(enabled.has("jira_search"));
  assert.ok(enabled.has("jira_create_issue"));
  assert.ok(enabled.has("confluence_search")); // inside core confluence_pages
  assert.ok(enabled.has("jira_get_changelog") === false); // jira_changelog not core
  assert.ok(enabled.has("jira_myself") === false);
});

test("TOOLSETS intersects with ENABLED_TOOLS", () => {
  const byToolset = resolveToolsets(new Set(["jira_issues"]));
  const enabled = new Set([
    "jira_search",
    "jira_get_issue",
    "confluence_search",
  ]).intersection(byToolset);
  assert.deepEqual([...enabled].sort(), ["jira_get_issue", "jira_search"]);
});

test("all-unknown toolsets resolve empty (fail closed)", () => {
  assert.equal(resolveToolsets(new Set(["bogus"])).size, 0);
});
