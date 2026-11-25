import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyPolicy,
  intersectCaps,
  effectiveSpaces,
  effectiveProjects,
  confluenceReadOnly,
  jiraReadOnly,
  type Policy,
} from "../src/policy.js";

function policyWith(p: Partial<Policy>): Policy {
  const base = emptyPolicy();
  return {
    ...base,
    ...p,
    global: { ...base.global, ...p.global } as Policy["global"],
  };
}

test("intersectCaps: undefined specific layer returns global cap", () => {
  assert.deepEqual(intersectCaps(["A", "B"], undefined), ["A", "B"]);
});

test("intersectCaps: undefined global cap returns specific scope", () => {
  assert.deepEqual(intersectCaps(undefined, ["A"]), ["A"]);
});

test("intersectCaps: both unset = unrestricted", () => {
  assert.equal(intersectCaps(undefined, undefined), undefined);
});

test("intersectCaps: narrows to common entries only", () => {
  assert.deepEqual(intersectCaps(["A", "B"], ["B", "C"]), ["B"]);
});

test("intersectCaps: empty specific = deny all, even with global cap", () => {
  assert.deepEqual(intersectCaps(["A"], []), []);
});

test("intersectCaps: cannot widen — non-overlap yields deny-all, not the user's list", () => {
  assert.deepEqual(intersectCaps(["A"], ["ZZZ"]), []);
});

test("effectiveSpaces: user rules intersect with global cap", () => {
  const p = policyWith({
    global: {
      confluence: { allowedSpaces: ["TEAM", "DOC"] },
      jira: {},
      allowWrites: false,
    },
    users: { alice: { confluence: { spaces: ["TEAM", "SECRET"] } } },
  });
  assert.deepEqual(effectiveSpaces(p, "alice"), ["TEAM"]);
});

test("effectiveSpaces: unknown user falls back to defaults, not to unrestricted", () => {
  const p = policyWith({
    global: {
      confluence: { allowedSpaces: ["TEAM", "DOC"] },
      jira: {},
      allowWrites: false,
    },
    defaults: { confluence: { spaces: ["DOC"] } },
    users: { alice: { confluence: { spaces: ["TEAM"] } } },
  });
  // bob has no user rule -> defaults apply (narrowed by cap)
  assert.deepEqual(effectiveSpaces(p, "bob"), ["DOC"]);
  // unresolved identity also falls back to defaults
  assert.deepEqual(effectiveSpaces(p, null), ["DOC"]);
});

test("effectiveSpaces: no user rules and no defaults = global cap only", () => {
  const p = policyWith({
    global: {
      confluence: { allowedSpaces: ["TEAM"] },
      jira: {},
      allowWrites: false,
    },
  });
  assert.deepEqual(effectiveSpaces(p, "alice"), ["TEAM"]);
  assert.deepEqual(effectiveSpaces(p, null), ["TEAM"]);
});

test("effectiveSpaces: empty policy = unrestricted (DC permissions still apply)", () => {
  assert.equal(effectiveSpaces(emptyPolicy(), "anyone"), undefined);
});

test("effectiveSpaces: a user rule can never add spaces outside the cap", () => {
  const p = policyWith({
    global: {
      confluence: { allowedSpaces: ["TEAM"] },
      jira: {},
      allowWrites: false,
    },
    users: { mallory: { confluence: { spaces: ["TEAM", "HR", "FINANCE"] } } },
  });
  assert.deepEqual(effectiveSpaces(p, "mallory"), ["TEAM"]);
});

test("effectiveProjects: same semantics on the jira side", () => {
  const p = policyWith({
    global: {
      confluence: {},
      jira: { allowedProjects: ["SUP"] },
      allowWrites: false,
    },
    users: { alice: { jira: { projects: ["SUP", "ENG"] } } },
  });
  assert.deepEqual(effectiveProjects(p, "alice"), ["SUP"]);
});

test("readOnly: global allowWrites=false makes both services read-only", () => {
  const p = emptyPolicy();
  assert.equal(confluenceReadOnly(p), true);
  assert.equal(jiraReadOnly(p), true);
});

test("readOnly: service-level readOnly wins even when writes are on", () => {
  const p = policyWith({
    global: {
      confluence: { readOnly: true },
      jira: {},
      allowWrites: true,
    },
  });
  assert.equal(confluenceReadOnly(p), true);
  assert.equal(jiraReadOnly(p), false);
});
