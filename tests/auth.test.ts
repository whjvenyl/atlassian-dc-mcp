import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCredentials, credHash } from "../src/auth.js";
import type { IncomingMessage } from "node:http";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

test("per-service PAT headers take precedence", () => {
  const c = extractCredentials(
    req({ "x-confluence-pat": "cpat", "x-jira-pat": "jpat" }),
  );
  assert.equal(c.confluence, "Bearer cpat");
  assert.equal(c.jira, "Bearer jpat");
});

test("X-Atlassian-PAT covers both services", () => {
  const c = extractCredentials(req({ "x-atlassian-pat": "onepat" }));
  assert.equal(c.confluence, "Bearer onepat");
  assert.equal(c.jira, "Bearer onepat");
});

test("Authorization Bearer is the last fallback", () => {
  const c = extractCredentials(req({ authorization: "Bearer tok123" }));
  assert.equal(c.confluence, "Bearer tok123");
  assert.equal(c.jira, "Bearer tok123");
});

test("Authorization Basic passes through as Basic", () => {
  const c = extractCredentials(req({ authorization: "Basic dXNlcjpwYXNz" }));
  assert.equal(c.confluence, "Basic dXNlcjpwYXNz");
  assert.equal(c.jira, "Basic dXNlcjpwYXNz");
});

test("specific PAT beats shared which beats Authorization", () => {
  const c = extractCredentials(
    req({
      "x-confluence-pat": "cpat",
      "x-atlassian-pat": "shared",
      authorization: "Bearer fallback",
    }),
  );
  assert.equal(c.confluence, "Bearer cpat");
  assert.equal(c.jira, "Bearer shared");
});

test("no credentials = both undefined", () => {
  const c = extractCredentials(req({}));
  assert.equal(c.confluence, undefined);
  assert.equal(c.jira, undefined);
});

test("non-Bearer/Basic Authorization is ignored", () => {
  const c = extractCredentials(req({ authorization: "Digest abc" }));
  assert.equal(c.confluence, undefined);
});

test("credHash is deterministic and does not leak the secret", () => {
  const h1 = credHash("Bearer secret1");
  const h2 = credHash("Bearer secret1");
  const h3 = credHash("Bearer secret2");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1!, /^[0-9a-f]{64}$/);
  assert.equal(credHash(undefined), null);
});
