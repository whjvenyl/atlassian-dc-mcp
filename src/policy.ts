import { readFileSync, statSync } from "node:fs";
import yaml from "js-yaml";

export type ServiceRules = { spaces?: string[]; projects?: string[] };

export type Policy = {
  global: {
    confluence: { allowedSpaces?: string[]; readOnly?: boolean };
    jira: { allowedProjects?: string[]; readOnly?: boolean };
    allowWrites: boolean;
  };
  defaults?: { confluence?: ServiceRules; jira?: ServiceRules };
  users?: Record<
    string,
    { confluence?: ServiceRules; jira?: ServiceRules }
  >;
};

export function emptyPolicy(): Policy {
  return {
    global: {
      confluence: {},
      jira: {},
      allowWrites: false,
    },
  };
}

/**
 * Load policy from YAML. A missing or empty file yields an empty policy:
 * no MCP-level caps — the caller's PAT permissions in DC still apply.
 */
export function loadPolicy(path: string): Policy {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(
      `atlassian-dc-mcp: no policy file at ${path} — running uncapped (PAT permissions in DC still apply)`,
    );
    return emptyPolicy();
  }
  const parsed = (yaml.load(raw) ?? {}) as Partial<Policy>;
  const p = emptyPolicy();
  p.global.confluence = parsed.global?.confluence ?? {};
  p.global.jira = parsed.global?.jira ?? {};
  p.global.allowWrites = parsed.global?.allowWrites ?? false;
  p.defaults = parsed.defaults;
  p.users = parsed.users;
  return p;
}

/** Reload policy when the file changed (mtime). Swallows errors: keeps last good policy. */
export function reloadIfChanged(
  path: string,
  current: { policy: Policy; mtimeMs: number },
): { policy: Policy; mtimeMs: number } {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs !== current.mtimeMs) {
      return { policy: loadPolicy(path), mtimeMs };
    }
  } catch {
    /* keep current */
  }
  return current;
}

/**
 * Intersect a global cap with a per-user/per-default scope.
 *   undefined        => this layer does not restrict
 *   []               => explicit "nothing" (deny all)
 *   both set         => intersection; non-overlap => [] (deny all)
 * The result can therefore never exceed the global cap.
 */
export function intersectCaps(
  globalCap: string[] | undefined,
  specific: string[] | undefined,
): string[] | undefined {
  if (specific === undefined) return globalCap;
  if (globalCap === undefined) return specific;
  const allowed = new Set(globalCap);
  return specific.filter((s) => allowed.has(s));
}

/** Effective Confluence space list for a user: undefined = unrestricted, [] = deny all. */
export function effectiveSpaces(
  policy: Policy,
  username: string | null,
): string[] | undefined {
  const userRules =
    (username ? policy.users?.[username]?.confluence?.spaces : undefined) ??
    policy.defaults?.confluence?.spaces;
  return intersectCaps(policy.global.confluence.allowedSpaces, userRules);
}

/** Effective Jira project list for a user. */
export function effectiveProjects(
  policy: Policy,
  username: string | null,
): string[] | undefined {
  const userRules =
    (username ? policy.users?.[username]?.jira?.projects : undefined) ??
    policy.defaults?.jira?.projects;
  return intersectCaps(policy.global.jira.allowedProjects, userRules);
}

export function confluenceReadOnly(policy: Policy): boolean {
  return !policy.global.allowWrites || !!policy.global.confluence.readOnly;
}

export function jiraReadOnly(policy: Policy): boolean {
  return !policy.global.allowWrites || !!policy.global.jira.readOnly;
}
