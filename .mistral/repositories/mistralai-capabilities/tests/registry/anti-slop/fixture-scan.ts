/**
 * Shared oxlint scan for the anti-slop fixture harness.
 *
 * Runs the plugin ONCE over this directory's `fixtures/` with the isolated harness config,
 * then normalizes each anti-slop diagnostic to the fixture directory and rule it belongs to. Both
 * `rules.test.ts` (assertions) and `rules.gen.ts` (count snapshot) consume this
 * so the two never drift on how the plugin is invoked or how output is parsed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import antiSlopEffectPlugin from "../../../tools/oxlint/anti-slop/effect/index.ts";
import antiSlopPlugin from "../../../tools/oxlint/anti-slop/index.ts";
import { REGISTRY_ROOT } from "../support/template-tree";

export const ANTI_SLOP_DIR = import.meta.dir;
export const HARNESS_DIR = ANTI_SLOP_DIR;
export const CONFIG_PATH = join(HARNESS_DIR, "oxlintrc.json");
export const FIXTURES_DIR = join(HARNESS_DIR, "fixtures");
export const OXLINT_BIN = join(REGISTRY_ROOT, "node_modules", ".bin", "oxlint");

/**
 * How a config rule key (`<plugin>/<rule>`) becomes a fixture directory name. The generic plugin
 * uses the bare rule name; the Effect plugin is namespaced with `effect--` so both live flat under
 * one fixtures directory without colliding.
 */
const PLUGIN_DIR_PREFIX = new Map<string, string>([
  ["anti-slop", ""],
  ["anti-slop-effect", "effect--"],
]);

const DIAGNOSTIC_CODE = /^([\w-]+)\(([\w-]+)\)$/u;

export type FixtureKind = "invalid" | "valid";

export type FixtureDiagnostic = {
  /** Fixture directory the diagnostic was reported in. */
  readonly dir: string;
  /** Which fixture file (`valid` or `invalid`) reported it. */
  readonly kind: FixtureKind;
  /** Config rule key (`<plugin>/<rule>`) the diagnostic's code maps to. */
  readonly ruleKey: string;
  /** 1-based source line, for failure messages a contributor can act on. */
  readonly line: number;
};

export type Scan = {
  /** Every anti-slop diagnostic, normalized to its fixture directory and rule. */
  readonly diagnostics: readonly FixtureDiagnostic[];
  /** Rule keys the HARNESS config switches on, sorted. Compared against the plugins, never trusted as the rule set. */
  readonly harnessRules: readonly string[];
  /** Fixture directories present on disk, sorted. */
  readonly fixtureDirs: readonly string[];
};

/** The fixture directory name a config rule key is covered by. */
export function fixtureDirForRule(ruleKey: string): string {
  const slash = ruleKey.indexOf("/");
  const plugin = ruleKey.slice(0, slash);
  const name = ruleKey.slice(slash + 1);
  const prefix = PLUGIN_DIR_PREFIX.get(plugin);
  if (prefix === undefined) throw new Error(`Unknown anti-slop plugin in rule key: ${ruleKey}`);
  return `${prefix}${name}`;
}

/**
 * Every rule the vendored plugins register, as the `<plugin>/<rule>` key a config spells.
 *
 * Read from the plugin objects rather than from any config, because the plugins are the only place
 * the rule set is actually defined. Deriving it from the harness config would make the coverage
 * guard circular: a rule added to a plugin and left out of the harness would be missing from BOTH
 * sides of the comparison and pass unnoticed, which is exactly the gap the guard exists to close.
 */
const registeredPlugins = [antiSlopPlugin, antiSlopEffectPlugin];

export const CANONICAL_RULE_KEYS: readonly string[] = registeredPlugins
  .flatMap((plugin) => {
    // `eslintCompatPlugin`'s return type leaves `meta` optional, but every plugin here declares
    // `meta.name`; a missing one is a broken plugin, not a rule to silently drop from coverage.
    const pluginName = plugin.meta?.name;
    if (pluginName === undefined) throw new Error("anti-slop plugin has no meta.name");
    return Object.keys(plugin.rules).map((name) => `${pluginName}/${name}`);
  })
  .toSorted();

/**
 * A rule entry as an oxlint config spells it: a bare severity, a numeric level, or a
 * `[severity, options]` tuple (which is how `no-runtime-typeof` carries `allowInTypeGuards`).
 */
type RuleSetting = string | number | readonly unknown[];

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

/** The severity a rule entry selects, normalised across the three spellings oxlint accepts. */
function ruleSeverity(setting: RuleSetting): string | null {
  const value = Array.isArray(setting) ? setting[0] : setting;
  if (isNumber(value)) return ["off", "warn", "error"][value] ?? null;
  return isString(value) ? value : null;
}

const ERRORING_SEVERITIES = new Set(["deny", "error"]);

/**
 * The `anti-slop*` rule keys a config switches on **as errors**.
 *
 * Severity is part of the assertion, not just presence: the install contract puts every rule at
 * `error`, and a key left in the config as `"off"` would otherwise satisfy a coverage check while
 * enforcing nothing — the same false-comfort the fixture guard was written to avoid.
 */
export function erroringRuleKeys(configPath: string): string[] {
  // SAFETY: configPath names a repo-committed oxlint config; a shape mismatch fails the tests reading it.
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    rules?: Record<string, RuleSetting>;
  };
  return Object.entries(config.rules ?? {})
    .filter(
      ([key, setting]) =>
        (key.startsWith("anti-slop/") || key.startsWith("anti-slop-effect/")) &&
        ERRORING_SEVERITIES.has(ruleSeverity(setting) ?? ""),
    )
    .map(([key]) => key)
    .toSorted();
}

function fixtureDirsOnDisk(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

type OxlintLabel = { readonly span?: { readonly line?: number } };
type OxlintDiagnostic = {
  readonly code?: string;
  readonly filename?: string;
  readonly labels?: readonly OxlintLabel[];
};

function normalize(raw: OxlintDiagnostic): FixtureDiagnostic | null {
  const match = raw.code === undefined ? null : DIAGNOSTIC_CODE.exec(raw.code);
  if (match === null) return null;
  const [, plugin, rule] = match;
  if (plugin === undefined || rule === undefined || !PLUGIN_DIR_PREFIX.has(plugin)) {
    return null;
  }
  const marker = "/fixtures/";
  const index = raw.filename?.indexOf(marker) ?? -1;
  if (raw.filename === undefined || index === -1) return null;
  const [dir, file] = raw.filename.slice(index + marker.length).split("/");
  if (dir === undefined || file === undefined) return null;
  const kind: FixtureKind = file.startsWith("valid.") ? "valid" : "invalid";
  return {
    dir,
    kind,
    ruleKey: `${plugin}/${rule}`,
    line: raw.labels?.[0]?.span?.line ?? 0,
  };
}

export function scanFixtures(): Scan {
  const result = Bun.spawnSync(
    [OXLINT_BIN, "--config", CONFIG_PATH, "--format=json", FIXTURES_DIR],
    {
      cwd: REGISTRY_ROOT,
    },
  );
  // oxlint exits non-zero whenever it reports diagnostics; that is the normal path here. Only
  // unparseable stdout indicates the scan itself failed (missing binary, config error, crash).
  const stdout = result.stdout.toString();
  let parsed: { diagnostics?: readonly OxlintDiagnostic[] };
  try {
    // SAFETY: oxlint --format=json emits this shape; a parse failure is caught here and rethrown.
    parsed = JSON.parse(stdout) as { diagnostics?: readonly OxlintDiagnostic[] };
  } catch (cause) {
    throw new Error(
      `oxlint produced no parseable JSON (exit ${result.exitCode}).\nstdout:\n${stdout}\nstderr:\n${result.stderr.toString()}`,
      { cause },
    );
  }
  const diagnostics = (parsed.diagnostics ?? []).flatMap((raw) => {
    const normalized = normalize(raw);
    return normalized === null ? [] : [normalized];
  });
  return {
    diagnostics,
    harnessRules: erroringRuleKeys(CONFIG_PATH),
    fixtureDirs: fixtureDirsOnDisk(),
  };
}

/** Number of `invalid.ts` diagnostics each enabled rule reports in its own fixture directory. */
export function invalidCountsByRule(scan: Scan) {
  const counts: Record<string, number> = {};
  for (const ruleKey of CANONICAL_RULE_KEYS) {
    const dir = fixtureDirForRule(ruleKey);
    counts[ruleKey] = scan.diagnostics.filter(
      (diagnostic) =>
        diagnostic.kind === "invalid" && diagnostic.dir === dir && diagnostic.ruleKey === ruleKey,
    ).length;
  }
  return counts;
}
