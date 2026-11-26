import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AtlassianClient } from "../src/client.js";
import { emptyPolicy, type Policy } from "../src/policy.js";
import { registerConfluenceTools } from "../src/tools/confluence.js";
import { registerJiraTools } from "../src/tools/jira.js";

/**
 * Handler-level tests: mock fetch, invoke tool handlers, assert the
 * outgoing request (URL, method, payload) and the returned content.
 * The point is the parts mocks CAN'T see: scope injection into JQL/CQL,
 * payload shapes, response mapping, and write gating.
 */

// ── fetch mock ─────────────────────────────────────────────────────────────

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];

/** Register canned responses keyed by substring of the request path. */
function mockFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes).find((k) => u.pathname.includes(k));
    const data = key ? routes[key] : {};
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const lastCall = () => calls[calls.length - 1];
const text = (r: { content?: { text?: string }[] }) =>
  (r.content ?? []).map((c) => c.text ?? "").join("\n");
const json = (r: { content?: { text?: string }[] }) => JSON.parse(text(r));

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  // leave fetch mocked — each test sets its own
});

// ── harness ────────────────────────────────────────────────────────────────

function toolByName(s: McpServer, name: string) {
  const internal = s as unknown as {
    _registeredTools?: Record<string, { handler: (a: unknown) => Promise<unknown> }>;
  };
  const t = internal._registeredTools?.[name];
  assert.ok(t, `tool ${name} not registered`);
  return t.handler;
}

function jiraServer(policy: Policy) {
  const s = new McpServer({ name: "t", version: "0" });
  registerJiraTools(
    s,
    new AtlassianClient("https://dc.example", "Bearer x"),
    "https://dc.example",
    () => policy,
    async () => "alice",
  );
  return s;
}

function confluenceServer(policy: Policy) {
  const s = new McpServer({ name: "t", version: "0" });
  registerConfluenceTools(
    s,
    new AtlassianClient("https://dc.example", "Bearer x"),
    "https://dc.example",
    () => policy,
    async () => "alice",
  );
  return s;
}

const scopedPolicy = (
  projects: string[] | undefined,
  spaces: string[] | undefined,
  allowWrites = true,
): Policy => ({
  global: {
    confluence: { allowedSpaces: spaces },
    jira: { allowedProjects: projects },
    allowWrites,
  },
});

const readOnlyPolicy = (): Policy => emptyPolicy(); // allowWrites defaults false

// ── jira_search: scope injection + pagination ──────────────────────────────

test("jira_search AND-s policy projects into JQL", async () => {
  mockFetch({ "/search": { issues: [], total: 0 } });
  const s = jiraServer(scopedPolicy(["SUP", "PLAT"], []));
  await toolByName(s, "jira_search")({ jql: "status = Open" });
  const c = lastCall();
  const jql = new URL(c.url).searchParams.get("jql")!;
  assert.equal(jql, "(status = Open) AND project in (SUP,PLAT)");
});

test("jira_search projectsFilter intersects with policy scope", async () => {
  mockFetch({ "/search": { issues: [], total: 0 } });
  const s = jiraServer(scopedPolicy(["SUP", "PLAT"], []));
  await toolByName(s, "jira_search")({
    jql: "status = Open",
    projectsFilter: "PLAT,EVIL",
  });
  const jql = new URL(lastCall().url).searchParams.get("jql")!;
  assert.equal(jql, "(status = Open) AND project in (PLAT)");
});

test("jira_search empty intersection refuses (never widens)", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await assert.rejects(
    toolByName(s, "jira_search")({ jql: "x=y", projectsFilter: "EVIL" }),
    /Policy denies/,
  );
  assert.equal(calls.length, 0); // no upstream call made
});

test("jira_search paginates via startAt + echoes nextStartAt", async () => {
  mockFetch({ "/search": { issues: [{}], total: 41 } });
  const s = jiraServer(scopedPolicy(undefined, undefined));
  const res = await toolByName(s, "jira_search")({ jql: "x=y", startAt: 20 });
  assert.equal(new URL(lastCall().url).searchParams.get("startAt"), "20");
  assert.equal(json(res).nextStartAt, 21);
});

// ── jira_get_issue: post-fetch scope check ─────────────────────────────────

test("jira_get_issue refuses when project is outside scope", async () => {
  mockFetch({
    "/issue/": { key: "EVIL-1", fields: { project: { key: "EVIL" } } },
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await assert.rejects(
    toolByName(s, "jira_get_issue")({ key: "EVIL-1" }),
    /Policy denies access to project 'EVIL'/,
  );
});

test("jira_get_issue passes fields/expand/commentLimit through", async () => {
  mockFetch({
    "/comment": { comments: [{ id: "1", body: "hi" }] },
    "/issue/": {
      key: "SUP-1",
      fields: { project: { key: "SUP" }, summary: "s" },
    },
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_issue")({
    key: "SUP-1",
    fields: "summary,customfield_1",
    expand: "transitions",
    commentLimit: 5,
    useDisplayNames: true,
  });
  const getUrl = calls[0].url;
  assert.equal(new URL(getUrl).searchParams.get("fields"), "summary,customfield_1");
  assert.equal(new URL(getUrl).searchParams.get("expand"), "transitions,names");
  assert.equal(new URL(calls[1].url).searchParams.get("maxResults"), "5");
  assert.equal(json(res).comments.length, 1);
});

test("jira_get_issue passes fieldsByKeys + updateHistory through", async () => {
  mockFetch({
    "/issue/": { key: "SUP-1", fields: { project: { key: "SUP" } } },
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_get_issue")({
    key: "SUP-1",
    fields: "summary",
    fieldsByKeys: true,
    updateHistory: true,
  });
  const u = new URL(lastCall().url);
  assert.equal(u.searchParams.get("fieldsByKeys"), "true");
  assert.equal(u.searchParams.get("updateHistory"), "true");
});

// ── jira write gating ──────────────────────────────────────────────────────

test("write tools refuse under allowWrites:false without calling upstream", async () => {
  mockFetch({});
  const s = jiraServer(readOnlyPolicy());
  const res = (await toolByName(s, "jira_create_issue")({
    project: "SUP",
    issueType: "Bug",
    summary: "x",
  })) as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(res.isError, true);
  assert.match(text(res), /Writes are disabled/);
  assert.equal(calls.length, 0);
});

// ── createmeta parsing ─────────────────────────────────────────────────────

const createmeta = {
  projects: [
    {
      issuetypes: [
        {
          id: "10002",
          name: "Bug",
          fields: {
            summary: { name: "Summary", required: true, schema: { type: "string" } },
            customfield_1: {
              name: "Team",
              required: false,
              schema: { type: "option", custom: "com.atlassian:sel" },
              allowedValues: [{ id: "10", value: "Platform" }, { id: "11", value: "Support" }],
            },
          },
        },
      ],
    },
  ],
};

test("jira_get_create_fields parses createmeta + names issue type", async () => {
  mockFetch({ "/issue/createmeta": createmeta });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_create_fields")({
    project: "SUP",
    issueType: "Bug",
  });
  const out = json(res);
  assert.equal(out.issueTypeId, "10002");
  assert.equal(out.fields.find((f: { id: string }) => f.id === "summary").required, true);
  assert.equal(out.fields.find((f: { id: string }) => f.id === "customfield_1").optionCount, 2);
});

test("jira_get_create_fields rejects unknown issue type with the available list", async () => {
  mockFetch({ "/issue/createmeta": createmeta });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await assert.rejects(
    toolByName(s, "jira_get_create_fields")({ project: "SUP", issueType: "Epic" }),
    /issue type 'Epic' not found in SUP\. Available: Bug/,
  );
});

test("jira_get_field_options filters by contains", async () => {
  mockFetch({ "/issue/createmeta": createmeta });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_field_options")({
    project: "SUP",
    issueType: "Bug",
    fieldId: "customfield_1",
    contains: "sup",
  });
  assert.deepEqual(json(res).options, [{ id: "11", value: "Support" }]);
});

test("createmeta prefers the DC 11 path form when available", async () => {
  mockFetch({
    "/issuetypes/10002": {
      values: [
        { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        { fieldId: "customfield_1", name: "Team", required: false,
          allowedValues: [{ id: "10", value: "Platform" }] },
      ],
    },
    "/issue/createmeta/SUP/issuetypes": { values: [{ id: "10002", name: "Bug" }] },
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_create_fields")({
    project: "SUP",
    issueType: "Bug",
  });
  const out = json(res);
  assert.equal(out.issueTypeId, "10002");
  assert.equal(out.fields[0].id, "summary");
  // DC 11 path hit first — no legacy query call needed
  assert.ok(calls.every((c) => !new URL(c.url).searchParams.has("projectKeys")));
});

test("createmeta falls back to legacy query form when the path form fails", async () => {
  mockFetch({ "/issue/createmeta": createmeta });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_create_fields")({
    project: "SUP",
    issueType: "Bug",
  });
  const out = json(res);
  assert.equal(out.issueTypeId, "10002");
  // tried the DC 11 path first, then legacy
  assert.ok(calls[0].url.includes("createmeta/SUP/issuetypes"));
  assert.ok(calls.some((c) => new URL(c.url).searchParams.has("projectKeys")));
});

// ── issue links ────────────────────────────────────────────────────────────

test("jira_create_issue_link posts the DC payload + checks BOTH projects", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP", "PLAT"], []));
  await toolByName(s, "jira_create_issue_link")({
    type: "Blocks",
    inwardKey: "SUP-1",
    outwardKey: "PLAT-9",
  });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/api/2/issueLink"));
  assert.deepEqual(c.body, {
    type: { name: "Blocks" },
    inwardIssue: { key: "SUP-1" },
    outwardIssue: { key: "PLAT-9" },
  });
});

test("jira_create_issue_link refuses when either project is out of scope", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = (await toolByName(s, "jira_create_issue_link")({
    type: "Blocks",
    inwardKey: "SUP-1",
    outwardKey: "EVIL-9",
  })) as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(res.isError, true);
  assert.match(text(res), /Policy denies access to project 'EVIL'/);
  assert.equal(calls.length, 0);
});

// ── confluence_search: CQL injection + smart query ─────────────────────────

test("confluence_search wraps plain text in siteSearch + space injection", async () => {
  mockFetch({ "/content/search": { results: [], size: 0 } });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_search")({ query: "deploy runbook" });
  const cql = new URL(lastCall().url).searchParams.get("cql")!;
  assert.equal(cql, '(siteSearch ~ "deploy runbook") AND space in ("DOC")');
});

test("confluence_search detects CQL, spacesFilter intersects", async () => {
  mockFetch({ "/content/search": { results: [], size: 0 } });
  const s = confluenceServer(scopedPolicy([], ["DOC", "OPS"]));
  await toolByName(s, "confluence_search")({
    query: "type = page AND label = runbook",
    spacesFilter: "OPS,EVIL",
  });
  const cql = new URL(lastCall().url).searchParams.get("cql")!;
  assert.equal(cql, '(type = page AND label = runbook) AND space in ("OPS")');
});

// ── confluence pages: scope + version bump ─────────────────────────────────

test("confluence_get_page refuses out-of-scope space", async () => {
  mockFetch({
    "/content/": { id: "1", title: "x", space: { key: "EVIL" } },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await assert.rejects(
    toolByName(s, "confluence_get_page")({ pageId: "1" }),
    /Policy denies access to space 'EVIL'/,
  );
});

test("confluence_update_page bumps version + carries minorEdit/message", async () => {
  mockFetch({
    "/content/": {
      id: "9",
      title: "t",
      space: { key: "DOC" },
      version: { number: 3 },
      body: { storage: { value: "<p>old</p>" } },
    },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_update_page")({
    pageId: "9",
    body: "<p>new</p>",
    versionComment: "fix",
    isMinorEdit: true,
  });
  const c = lastCall();
  assert.equal(c.method, "PUT");
  const body = c.body as { version: { number: number; minorEdit?: boolean; message?: string } };
  assert.equal(body.version.number, 4);
  assert.equal(body.version.minorEdit, true);
  assert.equal(body.version.message, "fix");
});

// ── confluence write gating + restrictions ─────────────────────────────────

test("confluence_add_comment refuses under readOnly without calling upstream", async () => {
  mockFetch({});
  const s = confluenceServer(readOnlyPolicy());
  const res = (await toolByName(s, "confluence_add_comment")({
    pageId: "1",
    body: "<p>x</p>",
  })) as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("confluence_update_page_restrictions PUTs the DC restriction shape", async () => {
  mockFetch({ "/content/": { id: "5", space: { key: "DOC" } } });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_update_page_restrictions")({
    pageId: "5",
    operation: "update",
    users: ["alice"],
    groups: ["doc-team"],
  });
  const c = lastCall();
  assert.equal(c.method, "PUT");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/api/content/5/restriction"));
  assert.deepEqual(c.body, [
    {
      operation: "update",
      restrictions: {
        user: [{ username: "alice" }],
        group: [{ name: "doc-team" }],
      },
    },
  ]);
});

// ── threaded/inline comments ───────────────────────────────────────────────

test("confluence_reply_to_comment posts ancestors + container", async () => {
  mockFetch({
    "/content/100": { id: "100", space: { key: "DOC" }, container: { id: "7" } },
    "/rest/api/content": { id: "101" },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_reply_to_comment")({
    commentId: "100",
    body: "<p>reply</p>",
  });
  const c = lastCall();
  const body = c.body as { type: string; container: { id: string }; ancestors: { id: string }[] };
  assert.equal(body.type, "comment");
  assert.equal(body.container.id, "7");
  assert.deepEqual(body.ancestors, [{ id: "100" }]);
});

test("confluence_get_comments passes location/depth params", async () => {
  mockFetch({
    "/child/comment": { results: [] },
    "/content/9": { id: "9", space: { key: "DOC" } },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_get_comments")({
    pageId: "9",
    location: "inline",
    depth: "all",
  });
  const c = lastCall();
  const u = new URL(c.url);
  assert.equal(u.searchParams.get("location"), "inline");
  assert.equal(u.searchParams.get("depth"), "all");
});

// ── jira attachments ───────────────────────────────────────────────────────

const issueWithAtt = {
  key: "SUP-1",
  fields: {
    project: { key: "SUP" },
    attachment: [
      { id: "10001", filename: "log.txt", mimeType: "text/plain", size: 12,
        content: "https://dc.example/rest/api/2/attachment/content/10001" },
      { id: "10002", filename: "big.zip", mimeType: "application/zip", size: 9e6 },
    ],
  },
};

test("jira_get_attachments maps fields + is project scoped", async () => {
  mockFetch({ "/issue/": issueWithAtt });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_attachments")({ key: "SUP-1" });
  const out = json(res);
  assert.equal(out.count, 2);
  assert.equal(out.attachments[0].filename, "log.txt");
  assert.ok(calls[0].url.includes("fields=attachment"));
});

test("jira_get_attachments refuses out-of-scope project", async () => {
  mockFetch({ "/issue/": issueWithAtt });
  const s = jiraServer(scopedPolicy(["PLAT"], []));
  await assert.rejects(
    toolByName(s, "jira_get_attachments")({ key: "SUP-1" }),
    /Policy denies access to project 'SUP'/,
  );
});

test("jira_delete_attachment verifies attachment belongs to the issue", async () => {
  mockFetch({ "/issue/": issueWithAtt });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = (await toolByName(s, "jira_delete_attachment")({
    key: "SUP-1",
    attachmentId: "99999",
  })) as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(res.isError, true);
  assert.match(text(res), /not found on SUP-1/);
  assert.equal(calls.length, 1); // only the scope lookup — no DELETE
});

test("jira_delete_attachment deletes after ownership check", async () => {
  mockFetch({ "/issue/": issueWithAtt });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_delete_attachment")({
    key: "SUP-1",
    attachmentId: "10001",
  });
  const c = lastCall();
  assert.equal(c.method, "DELETE");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/api/2/attachment/10001"));
});

test("jira_download_attachment rejects unknown attachment id", async () => {
  mockFetch({ "/issue/": issueWithAtt });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = (await toolByName(s, "jira_download_attachment")({
    key: "SUP-1",
    attachmentId: "99999",
  })) as { isError?: boolean };
  assert.equal(res.isError, true);
});

// ── jira transitions / worklogs / watchers ─────────────────────────────────

test("jira_transition_issue posts the transition id", async () => {
  mockFetch({
    "/issue/": {
      key: "SUP-1",
      fields: { project: { key: "SUP" } },
      transitions: [{ id: "31", name: "In Progress" }],
    },
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_transition_issue")({ key: "SUP-1", transition: "In Progress" });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/issue/SUP-1/transitions"));
  assert.deepEqual(c.body, { transition: { id: "31" } });
});

test("jira_add_worklog posts timeSpentSeconds + comment", async () => {
  mockFetch({ "/issue/": { key: "SUP-1", fields: { project: { key: "SUP" } } } });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_add_worklog")({
    key: "SUP-1",
    timeSpent: "1h",
    comment: "diagnosis",
  });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/issue/SUP-1/worklog"));
  const body = c.body as { timeSpent: string; comment?: string };
  assert.equal(body.timeSpent, "1h");
  assert.equal(body.comment, "diagnosis");
});

test("jira_add_issue_watcher PUTs the watcher name", async () => {
  mockFetch({ "/issue/": { key: "SUP-1", fields: { project: { key: "SUP" } } } });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_add_issue_watcher")({ key: "SUP-1", username: "bob" });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/issue/SUP-1/watchers"));
  assert.equal(c.body, "bob");
});

// ── confluence page ops ────────────────────────────────────────────────────

test("confluence_delete_page issues DELETE on the content id", async () => {
  mockFetch({ "/content/": { id: "7", space: { key: "DOC" } } });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_delete_page")({ pageId: "7" });
  const c = lastCall();
  assert.equal(c.method, "DELETE");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/api/content/7"));
});

test("confluence_copy_page recreates via POST /content with source body + parent", async () => {
  mockFetch({
    // longer path first — "includes" matching would shadow /content/7
    "/content/7": {
      id: "7",
      title: "t",
      space: { key: "DOC" },
      ancestors: [{ id: "3" }],
      body: { storage: { value: "<p>body</p>" } },
    },
    "/rest/api/content": { id: "99", title: "t (copy)", space: { key: "DOC" } },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  const res = await toolByName(s, "confluence_copy_page")({
    pageId: "7",
    title: "t (copy)",
  });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/api/content"));
  const body = c.body as {
    title: string;
    ancestors: { id: string }[];
    body: { storage: { value: string } };
  };
  assert.equal(body.title, "t (copy)");
  assert.deepEqual(body.ancestors, [{ id: "3" }]);
  assert.equal(body.body.storage.value, "<p>body</p>");
  assert.equal(json(res).id, "99");
});

test("confluence_add_label POSTs the global-prefix label", async () => {
  mockFetch({ "/content/": { id: "7", space: { key: "DOC" } } });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_add_label")({ pageId: "7", label: "runbook" });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/content/7/label"));
  assert.deepEqual(c.body, [{ prefix: "global", name: "runbook" }]);
});

test("confluence_remove_label DELETEs with the label name as query", async () => {
  mockFetch({ "/content/7": { id: "7", space: { key: "DOC" } } });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  await toolByName(s, "confluence_remove_label")({ pageId: "7", label: "stale-label" });
  const c = lastCall();
  assert.equal(c.method, "DELETE");
  const u = new URL(c.url);
  assert.ok(u.pathname.endsWith("/content/7/label"));
  assert.equal(u.searchParams.get("name"), "stale-label");
});

test("confluence_get_descendants drops out-of-scope descendants", async () => {
  mockFetch({
    "/descendant": {
      results: [
        { id: "10", title: "child A", space: { key: "DOC" }, version: {} },
        { id: "11", title: "child B", space: { key: "EVIL" }, version: {} },
      ],
    },
    "/content/9": { id: "9", space: { key: "DOC" } },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  const res = await toolByName(s, "confluence_get_descendants")({ pageId: "9" });
  const out = json(res);
  assert.equal(out.count, 1);
  assert.equal(out.pages[0].id, "10");
  assert.equal(out.filtered, 1);
});

test("confluence_get_page_version passes the version param", async () => {
  mockFetch({
    "/content/9": {
      id: "9",
      title: "t",
      space: { key: "DOC" },
      version: { number: 2 },
      body: { storage: { value: "<p>old</p>" } },
    },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC"]));
  const res = await toolByName(s, "confluence_get_page_version")({ pageId: "9", version: 2 });
  const u = new URL(lastCall().url);
  assert.equal(u.searchParams.get("version"), "2");
  assert.equal(json(res).body, "<p>old</p>");
});

test("confluence_list_spaces merges current+archived and reports unreachable policy keys", async () => {
  mockFetch({
    "/rest/api/space": {
      results: [
        { key: "DOC", name: "Docs", type: "global", status: "current" },
        { key: "PISANG", name: "Old", type: "global", status: "archived" },
      ],
    },
  });
  const s = confluenceServer(scopedPolicy([], ["DOC", "PISANG", "NOPE"]));
  const res = await toolByName(s, "confluence_list_spaces")({});
  const out = json(res);
  assert.equal(out.count, 2);
  assert.equal(out.spaces[1].status, "archived");
  assert.deepEqual(out.unreachable, ["NOPE"]);
});

// ── agile ──────────────────────────────────────────────────────────────────

const agileBoard = { id: 42, name: "Board", location: { projectKeyOrId: "SUP" } };

test("jira_get_board_issues checks board project + post-filters out-of-scope issues", async () => {
  mockFetch({
    "/board/42/issue": {
      total: 2,
      issues: [
        { key: "SUP-1", fields: { project: { key: "SUP" } } },
        { key: "EVIL-9", fields: { project: { key: "EVIL" } } },
      ],
    },
    "/board/42": agileBoard,
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_board_issues")({ boardId: 42 });
  const out = json(res);
  assert.equal(out.returned, 1);
  assert.equal(out.issues[0].key, "SUP-1");
  assert.equal(out.filtered, 1);
});

test("jira_get_board_issues refuses when the board's project is out of scope", async () => {
  mockFetch({ "/board/42": { id: 42, location: { projectKeyOrId: "EVIL" } } });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await assert.rejects(
    toolByName(s, "jira_get_board_issues")({ boardId: 42 }),
    /Policy denies access to project 'EVIL'/,
  );
});

test("jira_create_sprint POSTs originBoardId + dates", async () => {
  mockFetch({ "/board/42": agileBoard });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_create_sprint")({
    boardId: 42,
    name: "Sprint 7",
    startDate: "2026-12-01",
    endDate: "2026-12-15",
  });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/agile/1.0/sprint"));
  assert.deepEqual(c.body, {
    name: "Sprint 7",
    originBoardId: 42,
    startDate: "2026-12-01",
    endDate: "2026-12-15",
  });
});

test("jira_move_issues_to_epic refuses on any out-of-scope key", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = (await toolByName(s, "jira_move_issues_to_epic")({
    epicKey: "SUP-100",
    issueKeys: ["SUP-1", "EVIL-2"],
  })) as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(res.isError, true);
  assert.match(text(res), /EVIL/);
  assert.equal(calls.length, 0);
});

test("jira_rank_issues PUTs issues + rank anchors, all scope-checked", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_rank_issues")({
    issueKeys: ["SUP-1", "SUP-2"],
    rankAfter: "SUP-9",
  });
  const c = lastCall();
  assert.equal(c.method, "PUT");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/agile/1.0/issue/rank"));
  assert.deepEqual(c.body, { issues: ["SUP-1", "SUP-2"], rankAfterIssue: "SUP-9" });
});

test("jira_move_to_backlog POSTs the issue list", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await toolByName(s, "jira_move_to_backlog")({ issueKeys: ["SUP-1", "SUP-2"] });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/agile/1.0/backlog/issue"));
  assert.deepEqual(c.body, { issues: ["SUP-1", "SUP-2"] });
});

test("jira_get_backlog post-filters + board scope", async () => {
  mockFetch({
    "/backlog": {
      total: 2,
      issues: [
        { key: "SUP-1", fields: { project: { key: "SUP" } } },
        { key: "EVIL-1", fields: { project: { key: "EVIL" } } },
      ],
    },
    "/board/42": agileBoard,
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_backlog")({ boardId: 42 });
  const out = json(res);
  assert.equal(out.returned, 1);
  assert.equal(out.filtered, 1);
});

// ── editmeta / filters / lookups ───────────────────────────────────────────

test("jira_get_edit_fields scopes by key prefix, maps fields", async () => {
  mockFetch({
    "/editmeta": {
      fields: {
        summary: { name: "Summary", required: true, operations: ["set"], schema: { type: "string" } },
      },
    },
  });
  const s = jiraServer(scopedPolicy(["SUP"], []));
  const res = await toolByName(s, "jira_get_edit_fields")({ key: "SUP-1" });
  const out = json(res);
  assert.equal(out.fields[0].id, "summary");
  assert.deepEqual(out.fields[0].operations, ["set"]);
});

test("jira_get_edit_fields refuses out-of-scope key", async () => {
  mockFetch({});
  const s = jiraServer(scopedPolicy(["SUP"], []));
  await assert.rejects(
    toolByName(s, "jira_get_edit_fields")({ key: "EVIL-1" }),
    /Policy denies/,
  );
});

test("jira_get_filter returns the JQL", async () => {
  mockFetch({
    "/filter/123": { id: "123", name: "My filter", jql: "project = SUP", sharePermissions: [{}] },
  });
  const s = jiraServer(scopedPolicy(undefined, undefined));
  const res = await toolByName(s, "jira_get_filter")({ filterId: "123" });
  assert.equal(json(res).jql, "project = SUP");
});

test("jira_get_link_types maps inward/outward", async () => {
  mockFetch({
    "/issueLinkType": {
      issueLinkTypes: [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }],
    },
  });
  const s = jiraServer(scopedPolicy(undefined, undefined));
  const res = await toolByName(s, "jira_get_link_types")({});
  assert.equal(json(res).linkTypes[0].outward, "blocks");
});

test("confluence_convert_body POSTs value + representation", async () => {
  mockFetch({ "/convert": { value: "<p>rendered</p>", representation: "view" } });
  const s = confluenceServer(scopedPolicy([], []));
  await toolByName(s, "confluence_convert_body")({
    body: "<p>x</p>",
    to: "view",
  });
  const c = lastCall();
  assert.equal(c.method, "POST");
  assert.ok(new URL(c.url).pathname.endsWith("/rest/api/contentbody/convert/view"));
  assert.deepEqual(c.body, { value: "<p>x</p>", representation: "storage" });
});
