import { test } from "node:test";
import assert from "node:assert/strict";
import { audited } from "../src/audit.js";

// Capture stderr JSON lines emitted by the audited wrapper.
async function captureAudit(fn: () => Promise<unknown>): Promise<{
  line: Record<string, unknown> | null;
}> {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (msg?: unknown) => {
    lines.push(String(msg));
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  const last = lines.at(-1);
  return { line: last ? (JSON.parse(last) as Record<string, unknown>) : null };
}

const okUser = async () => "alice";

test("audited logs tool, user, denial flag and latency", async () => {
  const handler = audited("confluence_search", okUser, async () => ({
    content: [{ type: "text", text: "{}" }],
  }));
  const { line } = await captureAudit(() => handler({}));
  assert.ok(line);
  assert.equal(line.tool, "confluence_search");
  assert.equal(line.user, "alice");
  assert.equal(line.denied, false);
  assert.equal(typeof line.ms, "number");
});

test("thrown 'Policy denies' error is flagged denied", async () => {
  const handler = audited("jira_search", okUser, async () => {
    throw new Error("Policy denies jira_search: no Jira projects permitted.");
  });
  let threw = false;
  const { line } = await captureAudit(async () => {
    try {
      await handler({});
    } catch {
      threw = true;
    }
  });
  assert.equal(threw, true);
  assert.equal(line!.denied, true);
});

test("isError result mentioning policy is flagged denied", async () => {
  const handler = audited("jira_create_issue", okUser, async () => ({
    isError: true,
    content: [
      { type: "text", text: "Writes are disabled by server policy" },
    ],
  }));
  const { line } = await captureAudit(() => handler({}));
  assert.equal(line!.denied, true);
});

test("unresolved identity logs 'unknown', never fails the call", async () => {
  const handler = audited("confluence_get_page", async () => null, async () => ({
    content: [{ type: "text", text: "{}" }],
  }));
  const { line } = await captureAudit(() => handler({}));
  assert.equal(line!.user, "unknown");
});

test("a throwing getUsername still lets the tool result through", async () => {
  const handler = audited(
    "x",
    async () => {
      throw new Error("unreachable");
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  const res = await handler({});
  assert.equal(res.content?.[0]?.text, "ok");
});
