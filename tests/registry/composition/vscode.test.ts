/**
 * The optional `vscode` tooling capability owns the generated app's editor configuration and nothing
 * else. These tests prove two things the ticket requires:
 *
 *   1. an app that does not select `vscode` contains no `.vscode` assets at all (the concern is
 *      removable, not merely relabeled); and
 *   2. every representative selected combination renders valid JSON whose recommendations and
 *      settings reflect exactly the languages and tools present — no irrelevant or dangling entry,
 *      and none omitted when its capability is installed.
 *
 * The recommendations are gated on the *selection*, resolved by the same `{{#if (has "…")}}` renderer
 * the CLI uses, so the assertions run against the real template bytes rather than a transcription.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonValue } from "../../../scripts/shared/manifests";
import { capabilities, renderHbs, toLocalId } from "../support/selection";
import { capabilityDir, capabilityLocalIds, contributedPaths } from "../support/template-tree";

const VSCODE_DIR = join(capabilityDir("vscode"), "template", ".vscode");
const EXTENSIONS_HBS = readFileSync(join(VSCODE_DIR, "extensions.json.hbs"), "utf8");
const SETTINGS_HBS = readFileSync(join(VSCODE_DIR, "settings.json.hbs"), "utf8");

/** The capability ids the editor templates gate on. `core` (and thus Python) is always present. */
const GATES = ["code-quality", "tanstack-start", "docker-compose", "helm"] as const;

const recommend = (present: string[]): string[] => {
  const parsed: { recommendations: string[] } = JSON.parse(
    renderHbs(EXTENSIONS_HBS, new Set(present.map(toLocalId))),
  );
  return parsed.recommendations;
};

const settings = (present: string[]): Record<string, JsonValue> =>
  JSON.parse(renderHbs(SETTINGS_HBS, new Set(present.map(toLocalId))));
/** Every subset of the gates — the full power set of tool combinations the templates must survive. */
const powerSet = (items: readonly string[]): string[][] =>
  items.reduce<string[][]>(
    (acc, item) => [...acc, ...acc.map((subset) => [...subset, item])],
    [[]],
  );

describe("vscode capability manifest", () => {
  test("is an optional, non-default, template-only tooling capability that depends on core", () => {
    const cap = capabilities.get(toLocalId("vscode"))!;
    expect(cap.kind).toBe("tooling");
    expect(cap.required ?? false).toBe(false);
    expect(cap.default ?? false).toBe(false);
    expect(cap.dependencies).toEqual(["core"]);
    // Template-only: no package language, so no empty marker package is published.
    expect(cap.packages).toEqual([]);
  });

  test("does not depend on code-quality — it is independently selectable", () => {
    expect(capabilities.get(toLocalId("vscode"))!.dependencies ?? []).not.toContain("code-quality");
  });
});

describe("editor assets are owned solely by vscode", () => {
  test("only the vscode capability contributes any .vscode file", () => {
    const owners = new Map<string, string[]>();
    for (const id of capabilityLocalIds) {
      for (const path of contributedPaths(id)) {
        if (path.startsWith(".vscode/")) owners.set(path, [...(owners.get(path) ?? []), id]);
      }
    }
    for (const [path, ids] of owners) {
      expect(ids, `${path} is contributed by ${ids.join(", ")}, not vscode alone`).toEqual([
        toLocalId("vscode"),
      ]);
    }
    // And it does contribute the two editor files (a broken glob would leave this empty).
    expect([...owners.keys()].toSorted()).toEqual([
      ".vscode/extensions.json",
      ".vscode/settings.json",
    ]);
  });
});

describe("recommendations reflect the languages and tools present", () => {
  test("every tool combination renders valid JSON with no duplicate recommendation", () => {
    for (const subset of powerSet(GATES)) {
      const recs = recommend(subset);
      expect(new Set(recs).size, `duplicate recommendation for [${subset.join(", ")}]`).toBe(
        recs.length,
      );
      // settings.json must parse too.
      expect(() => settings(subset)).not.toThrow();
    }
  });

  test("Python support is always recommended (core always ships Python)", () => {
    expect(recommend([])).toEqual(["ms-python.python"]);
    expect(settings([])).toEqual({
      "python.defaultInterpreterPath": "${workspaceFolder}/.venv/bin/python",
    });
  });

  test("Ruff and ty appear only with code-quality, never dangling without it", () => {
    expect(recommend([])).not.toContain("charliermarsh.ruff");
    expect(recommend([])).not.toContain("astral-sh.ty");
    const withQuality = recommend(["code-quality"]);
    expect(withQuality).toContain("charliermarsh.ruff");
    expect(withQuality).toContain("astral-sh.ty");
    // The Python formatter block is configured only alongside the tools that provide it.
    expect(settings([])["[python]"]).toBeUndefined();
    expect(settings(["code-quality"])["[python]"]).toMatchObject({
      "editor.defaultFormatter": "charliermarsh.ruff",
    });
  });

  test("the Oxc TypeScript tooling appears only when both code-quality and web are present", () => {
    expect(recommend(["code-quality"])).not.toContain("oxc.oxc-vscode");
    expect(recommend(["tanstack-start"])).not.toContain("oxc.oxc-vscode");
    expect(recommend(["code-quality", "tanstack-start"])).toContain("oxc.oxc-vscode");
    expect(settings(["code-quality"])["[typescript]"]).toBeUndefined();
    expect(settings(["code-quality", "tanstack-start"])["[typescript]"]).toMatchObject({
      "editor.defaultFormatter": "oxc.oxc-vscode",
    });
  });

  test("the Docker extension appears only with docker-compose", () => {
    expect(recommend([])).not.toContain("ms-azuretools.vscode-docker");
    expect(recommend(["docker-compose"])).toContain("ms-azuretools.vscode-docker");
  });

  test("the Helm extension appears only with helm", () => {
    expect(recommend([])).not.toContain("tim-koehler.helm-intellisense");
    expect(recommend(["helm"])).toContain("tim-koehler.helm-intellisense");
  });

  test("a fully-tooled selection recommends every language and tool exactly once", () => {
    expect(recommend([...GATES]).toSorted()).toEqual(
      [
        "astral-sh.ty",
        "charliermarsh.ruff",
        "ms-azuretools.vscode-docker",
        "ms-python.python",
        "oxc.oxc-vscode",
        "tim-koehler.helm-intellisense",
      ].toSorted(),
    );
  });
});
