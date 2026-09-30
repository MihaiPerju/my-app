/**
 * The optional `testing` capability is the sole owner of the generated app's test infrastructure.
 *
 * Two fixtures, one selection with `testing` and one without, prove the exact assets and nx command
 * surface the capability adds — and that an app generated without it carries none of them. This is
 * the registry-level seam (descriptor closure + rendered templates + contributed files); the runtime
 * seam (the nx `testing` project's targets) is exercised by the generated-app pytest suite `testing`
 * itself ships (`tests/test_testing_tasks.py`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  appCommands,
  appFiles,
  capabilities,
  capabilityLocalIds,
  closure,
  toLocalId,
} from "../support/selection";
import { readTemplateText } from "../support/registry-fixtures";
import { contributedPaths, projectTargets, templateDir } from "../support/template-tree";

// The app-root files the capability owns end to end. Every one must vanish from an app that did not
// select `testing`, including its dependency workspace and standalone pytest/coverage configuration.
const TESTING_OWNED_FILES = [
  ".coveragerc",
  "conftest.py",
  "packages/py/testing/pyproject.toml",
  "pytest.ini",
  "tasks/testing/project.json",
  "tools/coverage-gate.sh",
  "tools/testing.sh",
  "tests/test_lock_provenance.py",
  "tests/test_composed_env_contract.py",
  "tests/test_testing_tasks.py",
  "tests/test_workspace_config.py",
];

// The nx targets the testing project contributes, as `project:target` handles. Preserved from the
// base app's suite so the migration breaks no familiar command.
const TESTING_COMMANDS = [
  "testing:test",
  "testing:test-cov",
  "testing:test-web-cov",
  "testing:check",
];

describe("tooling/testing capability", () => {
  test("is a defaulted, template-only tooling capability depending on core", () => {
    const manifest = capabilities.get(toLocalId("testing"));
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe("tooling");
    expect(manifest!.default).toBe(true);
    expect(manifest!.required ?? false).toBe(false);
    expect(manifest!.dependencies ?? []).toEqual(["core"]);
    // Template-only: no package zone, delivered through `sources.git`, no empty marker package.
    expect(manifest!.packages ?? []).toEqual([]);
  });

  test("a testing-selected app receives every testing asset and command", () => {
    const files = appFiles(["fastapi", "testing"]);
    for (const owned of TESTING_OWNED_FILES) {
      expect(files.has(owned), `testing app is missing ${owned}`).toBe(true);
    }

    // SAFETY: repo-owned dependency-only pyproject; malformed fields fail the assertions below.
    const dependencyProject = Bun.TOML.parse(
      readFileSync(join(templateDir("testing"), "packages/py/testing/pyproject.toml"), "utf8"),
    ) as { "dependency-groups"?: { dev?: string[] }; project?: { dependencies?: string[] } };
    expect(dependencyProject.project?.dependencies).toEqual([]);
    const dependencies = dependencyProject["dependency-groups"]?.dev ?? [];
    for (const dep of ["pytest", "pytest-asyncio", "pytest-cov", "respx", "pyyaml"]) {
      expect(
        dependencies.some((entry) => entry.startsWith(dep)),
        `testing dependency project must include ${dep}`,
      ).toBe(true);
    }
    expect(readFileSync(join(templateDir("testing"), "pytest.ini"), "utf8")).toContain(
      "asyncio_mode = auto",
    );
    expect(readFileSync(join(templateDir("testing"), ".coveragerc"), "utf8")).toContain(
      "branch = true",
    );

    const project = readFileSync(
      join(templateDir("testing"), "tasks", "testing", "project.json"),
      "utf8",
    );
    expect(projectTargets(project).toSorted()).toEqual([...TESTING_COMMANDS].toSorted());
  });

  test("a testing-free app contains no test files, runner config, coverage assets, or commands", () => {
    const selection = ["fastapi"];
    expect(closure(selection).has(toLocalId("testing"))).toBe(false);

    const files = appFiles(selection);
    for (const owned of TESTING_OWNED_FILES) {
      expect(files.has(owned), `testing-free app must not ship ${owned}`).toBe(false);
    }
  });

  test("the test/coverage targets live only in testing, not the base command surface", () => {
    // A testing-free app (core + api and the runtime concerns it depends on) exposes none of the
    // testing targets: core ships no project.json, so its command surface is empty, and no other
    // capability declares them.
    expect(closure(["fastapi"]).has(toLocalId("testing"))).toBe(false);
    const base = new Set(appCommands(["fastapi"]));
    for (const command of TESTING_COMMANDS) {
      expect(base.has(command), `${command} must not appear in a testing-free surface`).toBe(false);
    }
    // And no capability but `testing` declares them: across every capability's project.json files,
    // each testing target is declared exactly once, by `testing`.
    const owners = new Map<string, string[]>();
    for (const id of capabilityLocalIds) {
      for (const rel of contributedPaths(id)) {
        if (rel !== "project.json" && !rel.endsWith("/project.json")) continue;
        for (const command of projectTargets(readTemplateText(join(templateDir(id), rel)))) {
          if (!TESTING_COMMANDS.includes(command)) continue;
          owners.set(command, [...(owners.get(command) ?? []), id]);
        }
      }
    }
    for (const command of TESTING_COMMANDS) {
      expect(owners.get(command), `${command} must be declared once, by testing`).toEqual([
        toLocalId("testing"),
      ]);
    }
  });
});
