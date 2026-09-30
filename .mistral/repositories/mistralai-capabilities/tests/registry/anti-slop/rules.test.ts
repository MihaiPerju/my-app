/**
 * Anti-slop rule fixture harness.
 *
 * Every rule in the anti-slop plugin (and the opt-in Effect plugin) ships enabled as an error, so
 * each needs a fixture proving it fires where it should and stays silent where it should not. This
 * runs oxlint ONCE over `anti-slop/fixtures` with an isolated config (only the anti-slop plugins,
 * no builtin categories) and asserts, per fixture directory:
 *
 *   - `valid` reports no anti-slop diagnostics at all — the false-positive guard,
 *   - `invalid` reports diagnostics of its own rule ONLY — the cross-talk guard,
 *   - `invalid`'s count equals the pinned snapshot — the regression guard.
 *
 * The directory set must also equal the set of enabled rules, so a rule added to the plugin cannot
 * silently ship untested. Re-pin counts after an intentional change with
 *
 *     bun tests/registry/anti-slop/rules.gen.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CANONICAL_RULE_KEYS,
  erroringRuleKeys,
  fixtureDirForRule,
  FIXTURES_DIR,
  invalidCountsByRule,
  scanFixtures,
} from "./fixture-scan";
import { REGISTRY_ROOT } from "../support/template-tree";

const scan = scanFixtures();
const counts = invalidCountsByRule(scan);
// SAFETY: rules.snapshot.json is a repo-committed snapshot; a shape mismatch fails these tests.
const pinned = JSON.parse(
  readFileSync(join(import.meta.dir, "rules.snapshot.json"), "utf8"),
) as Record<string, number>;

const locate = (dir: string, base: "invalid" | "valid"): string | null =>
  ["ts", "tsx"].map((ext) => join(FIXTURES_DIR, dir, `${base}.${ext}`)).find(existsSync) ?? null;

const at = (diagnostics: readonly { ruleKey: string; line: number }[]): string[] =>
  diagnostics.map((diagnostic) => `${diagnostic.ruleKey} (line ${diagnostic.line})`);

describe("anti-slop rule fixtures", () => {
  test("the harness config switches on every rule the plugins register", () => {
    // Both this and the fixture check below compare against the PLUGINS, not against each other.
    // Deriving the expected set from the harness config would let a rule added to a plugin but
    // omitted here disappear from both sides of the comparison and ship untested.
    expect(scan.harnessRules).toEqual([...CANONICAL_RULE_KEYS]);
  });

  test("fixture directories exactly cover the rules the plugins register", () => {
    expect(scan.fixtureDirs).toEqual(CANONICAL_RULE_KEYS.map(fixtureDirForRule).toSorted());
  });

  test("both project configs switch on every generic rule the plugin registers", () => {
    // The template config is what a generated app lints with, so the two must not drift apart. The
    // Effect group is opt-in and deliberately off in this repo, hence generic-only.
    const generic = CANONICAL_RULE_KEYS.filter((key) => key.startsWith("anti-slop/"));
    for (const config of [
      ".oxlintrc.json",
      "capabilities/tooling/code-quality/template/.oxlintrc.json",
    ]) {
      expect({ config, rules: erroringRuleKeys(join(REGISTRY_ROOT, config)) }).toEqual({
        config,
        rules: [...generic],
      });
    }
  });

  for (const ruleKey of CANONICAL_RULE_KEYS) {
    const dir = fixtureDirForRule(ruleKey);
    const diagnosticsIn = (kind: "invalid" | "valid") =>
      scan.diagnostics.filter((diagnostic) => diagnostic.dir === dir && diagnostic.kind === kind);

    describe(ruleKey, () => {
      test("has both valid and invalid fixtures", () => {
        expect(locate(dir, "valid")).not.toBeNull();
        expect(locate(dir, "invalid")).not.toBeNull();
      });

      test("valid fixture triggers no anti-slop rule", () => {
        expect(at(diagnosticsIn("valid"))).toEqual([]);
      });

      test("invalid fixture triggers this rule only", () => {
        const diagnostics = diagnosticsIn("invalid");
        expect(
          diagnostics.length,
          `${ruleKey}'s invalid fixture emitted no diagnostic`,
        ).toBeGreaterThan(0);
        const crossTalk = diagnostics.filter((diagnostic) => diagnostic.ruleKey !== ruleKey);
        expect(at(crossTalk)).toEqual([]);
      });

      test("invalid fixture count matches the pinned snapshot", () => {
        expect(pinned).toHaveProperty(ruleKey);
        expect(counts[ruleKey]).toBe(pinned[ruleKey]);
      });
    });
  }
});
