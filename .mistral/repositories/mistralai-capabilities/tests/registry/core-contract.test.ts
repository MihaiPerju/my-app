/**
 * The required `core` base is contracted to the shared application substrate.
 *
 * After the per-concern split, `core` owns only what every composition needs: workspace identity and
 * resolution, the shared env/client/application packages, the nx workspace config plus the shell
 * tools every app bootstraps with (`tools/uv.sh`, `tools/install.sh`), and repository guidance. It
 * defines no nx project of its own, so its command surface is empty; the universal commands are the
 * root package.json scripts. Every deployment, tooling, runtime, and feature command travels with the
 * capability that owns it. These fixtures prove that at the registry seam (descriptor closure +
 * rendered manifests + contributed files + nx command surface):
 *
 *  - the required base alone is internally valid and carries no optional concern; and
 *  - a `core + api` app is deployment- and tooling-free.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appCommands, appFiles, capabilities, closure, toLocalId } from "./support/selection";
import { contributedPaths, templateDir } from "./support/template-tree";

// The universal scripts every generated app's root package.json ships. Optional concerns expose
// their commands through their own NX projects instead of mutating this manifest.
const UNIVERSAL_SCRIPTS = ["build", "test", "dev:web", "check", "install-all", "lock"];

// The optional deployment and tooling capabilities. None may appear in a `core + api` closure, and
// none of their assets or commands may reach a deployment- and tooling-free app.
const DEPLOYMENT_CAPS = ["docker-compose", "helm", "k3d"];
const TOOLING_CAPS = ["code-quality", "testing", "github-automation", "vscode"];

// Representative app-root assets each optional concern owns end to end. Every one must be absent from
// a `core + api` app: lint/format config and the anti-slop plugin (code-quality), the pytest
// bootstrap (testing), CI and Renovate (github-automation), editor settings (vscode), the Compose
// roots (docker-compose), the umbrella chart (helm), and the local-cluster overlay (k3d).
const OPTIONAL_ASSETS = [
  ".oxlintrc.json",
  ".pre-commit-config.yaml",
  "conftest.py",
  ".github/workflows/ci.yml",
  ".vscode/settings.json",
  "deploy/compose/compose.yaml",
  "deploy/helm/app/Chart.yaml",
  "deploy/k3d/values-local.yaml",
];

describe("core contraction", () => {
  test("the required base is the only required capability and depends on nothing", () => {
    const core = capabilities.get(toLocalId("core"));
    expect(core?.required).toBe(true);
    expect(core?.dependencies ?? []).toEqual([]);
    // The base alone installs exactly itself — no optional concern rides in through a dependency.
    expect([...closure([])].toSorted()).toEqual(["base/core"]);
  });

  test("the base ships the nx workspace substrate", () => {
    const core = templateDir("core");
    // The base carries the workspace-wide nx config and the shell tools every app bootstraps with —
    // the uv wrapper and the workspace installer — in place of the old Invoke `tasks/` package.
    for (const asset of ["nx.json", "tools/uv.sh", "tools/install.sh"]) {
      expect(existsSync(join(core, asset)), `core must ship ${asset}`).toBe(true);
    }
    // The Invoke `tasks/` package is gone; no capability may reintroduce it in the base.
    expect(existsSync(join(core, "tasks")), "core must not ship a tasks/ package").toBe(false);
    // core is pure substrate: it defines no nx project, so it contributes no project.json and adds
    // no target to any app's command surface.
    const projects = contributedPaths("core").filter((rel) => rel.endsWith("project.json"));
    expect(projects, "core must define no nx project").toEqual([]);
  });

  test("a base-only app presents exactly the universal base commands", () => {
    // core ships no project.json, so a base-only app's nx command surface is empty: the universal
    // commands are the root package.json scripts, not nx targets.
    expect(appCommands([])).toEqual([]);
    const pkg = readFileSync(join(templateDir("core"), "package.json"), "utf8");
    // SAFETY: repo-owned static manifest; a shape mismatch throws here.
    const parsed = JSON.parse(pkg) as { scripts?: Record<string, string> };
    expect(Object.keys(parsed.scripts ?? {}).toSorted()).toEqual([...UNIVERSAL_SCRIPTS].toSorted());
  });

  test("a core + api app pulls in no deployment or tooling capability", () => {
    const selected = closure(["fastapi"]);
    for (const cap of [...DEPLOYMENT_CAPS, ...TOOLING_CAPS]) {
      expect(selected.has(toLocalId(cap)), `core + api must not install ${cap}`).toBe(false);
    }
  });

  test("a core + api app ships no lint, test, CI, editor, or deployment assets", () => {
    const files = appFiles(["fastapi"]);
    for (const asset of OPTIONAL_ASSETS) {
      expect(files.has(asset), `core + api must not ship ${asset}`).toBe(false);
    }
    // No CI, editor, or deployment-orchestration tree at all. Runtime Dockerfiles (`deploy/docker/`)
    // are owned by the runtime/database capabilities and legitimately remain.
    for (const path of files) {
      expect(path.startsWith(".github/"), `unexpected CI asset ${path}`).toBe(false);
      expect(path.startsWith(".vscode/"), `unexpected editor asset ${path}`).toBe(false);
      for (const tree of ["deploy/compose/", "deploy/helm/", "deploy/k3d/"]) {
        expect(path.startsWith(tree), `unexpected deployment asset ${path}`).toBe(false);
      }
    }
  });

  test("a core + FastAPI command surface contains only the generic HTTP host", () => {
    const commands = appCommands(["fastapi"]);
    expect(commands.toSorted()).toEqual(["api:gen-openapi", "api:serve"]);
    // And explicitly none of the tooling or deployment concerns' targets.
    const present = new Set(commands);
    for (const target of [
      "quality:fix",
      "quality:lint",
      "testing:test",
      "helm:validate",
      "k3d:up",
      "compose:up",
      "compose:smoke",
    ]) {
      expect(present.has(target), `core + api must not expose ${target}`).toBe(false);
    }
  });

  test("core's public-facing source is audience-neutral", () => {
    const core = templateDir("core");
    const app = readFileSync(join(core, "packages/py/env/src/env/app.py"), "utf8");
    const telemetry = readFileSync(join(core, "packages/py/env/src/env/telemetry.py"), "utf8");
    const skill = readFileSync(join(core, ".agents/skills/capability-core/SKILL.md"), "utf8");
    expect(app).toContain('app_name: str = "app-workspace"');
    expect(telemetry).toContain('telemetry_service_name: str = "app-workspace"');
    expect(`${app}\n${telemetry}\n${skill}`).not.toMatch(
      /Keycloak|search corpus|reference deployment|mistral\.obs\.internal|private-index|pull token/i,
    );
  });

  test("core shares one audience-neutral logging config for internal and public variants", () => {
    const core = templateDir("core");
    const canonical = readFileSync(join(core, "packages/py/utils/src/utils/logging.py"), "utf8");
    // No per-audience override: the canonical file is packed unchanged for every index, so it must
    // not reference an internal-only logger.
    expect(canonical).not.toContain('"mistralai.workflows"');
    expect(canonical).not.toContain('"temporalio"');
    expect(canonical).toContain('"uvicorn": {"handlers": [], "propagate": True}');
  });

  test("core's public INSTALL discloses the telemetry default and opt-out", () => {
    const install = readFileSync(join(templateDir("core"), "..", "INSTALL.md"), "utf8");
    expect(install).toContain("When the FastAPI host is selected");
    expect(install).toContain("is enabled by default");
    expect(install).toContain("https://api.mistral.ai/telemetry/v1/logs");
    expect(install).toContain("TELEMETRY_ENABLED=false");
  });

  test("core's root manifests are static and tooling-free", () => {
    const pkg = readFileSync(join(templateDir("core"), "package.json"), "utf8");
    // SAFETY: repo-owned static manifest; a shape mismatch throws here.
    const parsed = JSON.parse(pkg) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    for (const dep of Object.keys(parsed.devDependencies ?? {})) {
      expect(dep.startsWith("oxlint"), `core must not own lint dependency ${dep}`).toBe(false);
    }
    const pyproject = readFileSync(join(templateDir("core"), "pyproject.toml"), "utf8");
    // SAFETY: repo-owned static manifest; Bun.TOML throws on an invalid file.
    const toml = Bun.TOML.parse(pyproject) as {
      tool?: { ruff?: unknown; pytest?: unknown; ty?: unknown };
    };
    expect(toml.tool?.ruff).toBeUndefined();
    expect(toml.tool?.pytest).toBeUndefined();
    expect(toml.tool?.ty).toBeUndefined();
    expect(pkg).not.toContain("{{");
    expect(pyproject).not.toContain("{{");
  });
});
