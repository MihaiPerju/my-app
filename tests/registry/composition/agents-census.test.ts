/**
 * The orchestrator must hold for any capability selection.
 *
 * The agents census (`apps/worker/tests/agents/test_app.py`) once hard-coded search's tools, the
 * connector roster and the guardrail hook, so `mistral apps init --caps chat` scaffolded an app
 * whose `agents:test` failed out of the box. It now derives its expectations from the installed
 * selection through per-capability tables keyed by full identity (`registry/kind/id`); these tests
 * keep each table entry in step with what that capability actually vendors into the orchestrator,
 * and keep the shared prompt and the agents project's type check free of selection assumptions.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { uniqueCapabilityId } from "../../../scripts/shared/capability-identity";
import { REGISTRY_ID } from "../support/registry-fixtures";
import { capabilityRoots, templateDir } from "../support/template-tree";

const AGENTS_PROJECT = join("apps", "worker", "src", "worker", "agents");
const CONTRIBUTION_KINDS = {
  tools: "CAPABILITY_TOOLS",
  connectors: "CAPABILITY_CONNECTORS",
  hooks: "CAPABILITY_HOOKS",
} as const;
type ContributionKind = keyof typeof CONTRIBUTION_KINDS;
const isContributionKind = (key: string): key is ContributionKind =>
  Object.hasOwn(CONTRIBUTION_KINDS, key);

const agentsTemplate = templateDir("feature/agents");
const census = readFileSync(
  join(agentsTemplate, "apps", "worker", "tests", "agents", "test_app.py"),
  "utf8",
);
const instructions = readFileSync(join(agentsTemplate, AGENTS_PROJECT, "instructions.md"), "utf8");

/**
 * The public contribution modules (`_`-prefixed are private helpers) each capability vendors, per
 * kind, keyed by the capability's full identity.
 */
function contributions(kind: ContributionKind): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of capabilityRoots) {
    if (root.id === "agents") continue;
    const dir = join(templateDir(`${root.kind}/${root.id}`), AGENTS_PROJECT, kind);
    if (!existsSync(dir)) continue;
    const modules = readdirSync(dir)
      .filter((file) => file.endsWith(".py") && !file.startsWith("_"))
      .map((file) => file.slice(0, -".py".length));
    if (modules.length > 0) found.set(uniqueCapabilityId(REGISTRY_ID, root), modules);
  }
  return found;
}

/** The `REGISTRY = "..."` constant the census prefixes its identities with. */
function registryOf(source: string): string {
  const match = /^REGISTRY = "([^"]+)"$/m.exec(source);
  if (match?.[1] === undefined) throw new Error("test_app.py has no REGISTRY constant");
  return match[1];
}

/**
 * The entries of one `CAPABILITY_*` table (`NAME: dict[...] = { ... }`), identity -> its own names.
 * Each entry is `"<identity>": {...}` or `"<identity>": set()`; `{REGISTRY}` in an f-string key is
 * expanded. Names are read from the entry's own set only, so a name filed under another capability
 * does not count for this one.
 */
function tableEntries(source: string, name: string): Map<string, string[]> {
  const match = new RegExp(
    `^${name}: dict\\[str, set\\[str\\]\\] = \\{\\n([\\s\\S]*?)^\\}`,
    "m",
  ).exec(source);
  if (match?.[1] === undefined) throw new Error(`test_app.py has no ${name} table`);
  const registry = registryOf(source);
  const body = match[1].replace(/^\s*#.*$/gm, "");
  const entries = new Map<string, string[]>();
  for (const entry of body.matchAll(/f?"([^"]+)":\s*(set\(\)|\{[^}]*\})/g)) {
    const [, key = "", value = ""] = entry;
    const identity = key.replace("{REGISTRY}", registry);
    if (entries.has(identity)) throw new Error(`${name} lists ${identity} twice`);
    entries.set(
      identity,
      [...value.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""),
    );
  }
  return entries;
}

/**
 * The `<identity>/<module>` pairs whose module is not named in that capability's own entry. An
 * entry of `set()` declares that the capability's modules contribute nothing by default (mcp-apps'
 * off-by-default connector), so its modules are not required.
 */
function unlistedModules(
  entries: Map<string, string[]>,
  vendored: Map<string, string[]>,
): string[] {
  return [...vendored].flatMap(([identity, modules]) => {
    const own = entries.get(identity);
    if (own === undefined) return modules.map((module) => `${identity}/${module}`);
    if (own.length === 0) return [];
    return modules.filter((module) => !own.includes(module)).map((m) => `${identity}/${m}`);
  });
}

describe("agents census", () => {
  test("derives its expectations from the installed selection", () => {
    expect(census).toContain('".mistral" / "capabilities.json"');
    // The old hard-coded sets, which failed every composition without search+connectors+guardrailing.
    expect(census).not.toMatch(/^EXPECTED_(TOOLS|CONNECTORS|HOOKS)\b/m);
  });

  test("keys its tables by this registry's full identities", () => {
    expect(registryOf(census)).toBe(REGISTRY_ID);
    const known = new Set(capabilityRoots.map((root) => uniqueCapabilityId(REGISTRY_ID, root)));
    const unknown = Object.values(CONTRIBUTION_KINDS).flatMap((tableName) =>
      [...tableEntries(census, tableName).keys()].filter((identity) => !known.has(identity)),
    );
    expect(unknown).toEqual([]);
  });

  for (const kind of Object.keys(CONTRIBUTION_KINDS).filter(isContributionKind)) {
    const tableName = CONTRIBUTION_KINDS[kind];
    test(`lists every capability that contributes ${kind} in ${tableName}`, () => {
      const entries = tableEntries(census, tableName);
      const missing = [...contributions(kind).keys()].filter((identity) => !entries.has(identity));
      expect(missing, `add these capabilities' ${kind} to ${tableName} in test_app.py`).toEqual([]);
    });
  }

  // Tool and connector names equal their module names by convention; an entry that lists the
  // capability but misses one of its modules (or files it under another capability) would still let
  // the census drift.
  for (const kind of ["tools", "connectors"] as const) {
    test(`names every contributed ${kind} module under its own capability in ${CONTRIBUTION_KINDS[kind]}`, () => {
      const entries = tableEntries(census, CONTRIBUTION_KINDS[kind]);
      expect(unlistedModules(entries, contributions(kind))).toEqual([]);
    });
  }

  test("a module filed under the wrong capability is reported", () => {
    const misfiled = [
      'REGISTRY = "reg"',
      "CAPABILITY_TOOLS: dict[str, set[str]] = {",
      '    f"{REGISTRY}/feature/search": {"search_open"},',
      "    # search_read is listed, but under the wrong capability.",
      '    f"{REGISTRY}/feature/other": {"other_tool", "search_read"},',
      "}",
      "",
    ].join("\n");
    const entries = tableEntries(misfiled, "CAPABILITY_TOOLS");
    expect(entries.get("reg/feature/search")).toEqual(["search_open"]);
    const vendored = new Map([
      ["reg/feature/search", ["search_open", "search_read"]],
      ["reg/feature/other", ["other_tool"]],
      ["reg/tooling/search", ["search_grep"]],
    ]);
    expect(unlistedModules(entries, vendored)).toEqual([
      "reg/feature/search/search_read",
      "reg/tooling/search/search_grep",
    ]);
  });
});

describe("agents project", () => {
  test("instructions.md names no capability's tools, so it holds for every selection", () => {
    const toolNames = [...contributions("tools").values()].flat();
    const named = toolNames.filter((name) => instructions.includes(name));
    expect(named).toEqual([]);
    // Prose wraps, so compare on collapsed whitespace: the old prompt said "Use persistent\nsearch".
    expect(instructions.toLowerCase().replace(/\s+/g, " ")).not.toContain("persistent search");
  });

  test("instructions.md tells the model how to cite, and not to wrap links in code", () => {
    expect(instructions).toContain("[title](url)");
    expect(instructions).toMatch(/never wrap\s+a link in backticks/i);
  });

  // `ty check --config-file <pyproject.toml>` parses the pyproject as a ty.toml and rejects
  // `[dependency-groups]`, so `agents:typecheck` failed on every scaffold.
  test("no project target hands ty a pyproject.toml as its config file", () => {
    const offenders = capabilityRoots.flatMap((root) => {
      const template = templateDir(`${root.kind}/${root.id}`);
      if (!existsSync(template)) return [];
      return [...new Bun.Glob("**/project.json").scanSync({ cwd: template, dot: true })]
        .filter((path) =>
          /ty check[^"]*--config-file\s+\S*pyproject\.toml/.test(
            readFileSync(join(template, path), "utf8"),
          ),
        )
        .map((path) => `${root.kind}/${root.id}: ${path}`);
    });
    expect(offenders).toEqual([]);
  });
});
