import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AtlassianClient } from "../src/client.js";
import { emptyPolicy, type Policy } from "../src/policy.js";
import { registerConfluenceTools } from "../src/tools/confluence.js";
import { registerJiraTools } from "../src/tools/jira.js";
import { enabledToolFilter } from "../src/tools/filter.js";

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
    "confluence_create_page",
    "confluence_current_user",
    "confluence_get_comments",
    "confluence_get_page",
    "confluence_get_page_children",
    "confluence_list_spaces",
    "confluence_search",
    "confluence_update_page",
  ]);
});

test("jira tools register", () => {
  const s = new McpServer({ name: "t", version: "0" });
  registerJiraTools(s, fakeClient(), "https://dc.example", getPolicy, getUsername);
  assert.deepEqual(toolNames(s), [
    "jira_add_comment",
    "jira_create_issue",
    "jira_get_changelog",
    "jira_get_comments",
    "jira_get_issue",
    "jira_get_transitions",
    "jira_list_projects",
    "jira_myself",
    "jira_search",
    "jira_transition_issue",
    "jira_update_issue",
  ]);
});

test("ENABLED_TOOLS filters registration", () => {
  const s = new McpServer({ name: "t", version: "0" });
  const enabled = new Set(["jira_search", "jira_get_issue"]);
  registerJiraTools(
    enabledToolFilter(s, enabled),
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
    enabledToolFilter(s, undefined),
    fakeClient(),
    "https://dc.example",
    getPolicy,
    getUsername,
  );
  assert.equal(toolNames(s).length, 11);
});
