/**
 * The optional `github-automation` capability is the sole owner of the generated app's GitHub CI
 * and dependency-update automation, and its emitted workflows must reference only nx targets and
 * assets that exist in the selected closure.
 *
 * These tests prove, against the real template bytes:
 *   1. the manifest contract (defaulted tooling, template-only, depends on code-quality + testing);
 *   2. that `.github/workflows` and `renovate.json` are owned solely by github-automation, and that
 *      an app that does not select it contains none of them;
 *   3. that the CI workflow's optional jobs render iff their capability is in the closure, the
 *      end-to-end job's `needs:` never dangles, and the result is valid YAML; and
 *   4. that every nx target, script, and deployment asset a rendered workflow names belongs to a
 *      project or asset in the closure — no lint/test/agent/type/postgres/compose reference dangles.
 *
 * The CI carrier is `ci.yml.hbs`. Its gates are the same `{{#if (has "…")}}` the CLI resolves; its
 * GitHub `${{ … }}` expressions are backslash-escaped so full Handlebars leaves them intact, so the
 * rendered form here mirrors the CLI by resolving gates AND unescaping `\{{` → `{{`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  appFiles,
  capabilities,
  capabilityLocalIds,
  closure,
  renderHbs,
  toLocalId,
} from "./support/selection";
import { contributedPaths, projectTargets, templateDir } from "./support/template-tree";

const OWNER = "github-automation";
const OWNER_LOCAL = toLocalId(OWNER);

/** The app-root paths github-automation owns end to end (rendered names, `.hbs` resolved). */
const AUTOMATION_OWNED_FILES = [
  ".github/actions/uv-workspace/action.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/solutions-security-gate.yml",
  "renovate.json",
];

const CI_HBS = readFileSync(join(templateDir(OWNER), ".github", "workflows", "ci.yml.hbs"), "utf8");

/** The optional CI jobs and the capabilities each needs. The rest (py-*) are unconditional. */
const JOB_GATE = {
  "agent-checks": ["agents"],
  "ts-checks": ["tanstack-start"],
  // The generated client exists only when there is an API to generate it from.
  "gen-types-drift": ["tanstack-start", "fastapi"],
  "pg-contract": ["postgres"],
  e2e: ["docker-compose"],
} satisfies Record<string, string[]>;
const ALWAYS_JOBS = ["py-lint", "py-typecheck", "py-test"];

/**
 * The CI workflow as the app of `present` receives it: gates resolved, then `\{{` unescaped to `{{`
 * exactly as full Handlebars renders the backslash-escaped GitHub expressions.
 */
function renderCi(present: Set<string>): string {
  return renderHbs(CI_HBS, present).replaceAll("\\{{", "{{");
}

interface Workflow {
  jobs?: Record<string, { needs?: string | string[]; steps?: { run?: string }[] }>;
}

function parseCi(present: Set<string>): Workflow {
  // SAFETY: repo-owned carrier rendered with a valid selection; a shape mismatch fails the asserts.
  return Bun.YAML.parse(renderCi(present)) as Workflow;
}

/** Every nx project a selection's closure installs — a project exists iff it ships a `project.json`. */
function availableProjects(selection: string[]): Set<string> {
  const projects = new Set<string>();
  const present = closure(selection);
  for (const id of present) {
    for (const rel of contributedPaths(id)) {
      if (rel !== "project.json" && !rel.endsWith("/project.json")) continue;
      const source = [rel, `${rel}.hbs`]
        .map((candidate) => join(templateDir(id), candidate))
        .find((candidate) => existsSync(candidate));
      if (source === undefined) throw new Error(`${id}: no source for rendered ${rel}`);
      for (const target of projectTargets(renderHbs(readFileSync(source, "utf8"), present))) {
        projects.add(target.slice(0, target.indexOf(":")));
      }
    }
  }
  return projects;
}

/** The `nx run <project>:<target>` handles a rendered workflow runs (`bunx nx run …`). */
function invokedTargets(rendered: string): string[] {
  const targets: string[] = [];
  // Anchored on the real `bunx nx run …` runner so a target named in prose is not read as a run.
  for (const m of rendered.matchAll(/bunx nx run\s+([a-z0-9-]+:[a-z0-9-]+)/g)) targets.push(m[1]!);
  return targets;
}

/** The matrix: owner alone, owner + each gate, the default starter, and the whole catalog. */
const SELECTIONS: string[][] = [
  [OWNER],
  [OWNER, "agents"],
  [OWNER, "tanstack-start"],
  [OWNER, "postgres"],
  [OWNER, "docker-compose"],
  ["tanstack-start", "fastapi", "postgres", "docker-compose", "code-quality", "testing", OWNER],
  [...capabilityLocalIds],
];

describe("tooling/github-automation capability", () => {
  test("is a defaulted, template-only tooling capability depending on code-quality and testing", () => {
    const manifest = capabilities.get(OWNER_LOCAL);
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe("tooling");
    expect(manifest!.default).toBe(true);
    expect(manifest!.required ?? false).toBe(false);
    expect((manifest!.dependencies ?? []).toSorted()).toEqual(["code-quality", "testing"]);
    // Template-only: no package zone, delivered through `sources.git`, no empty marker package.
    expect(manifest!.packages ?? []).toEqual([]);
  });

  test("owns every .github and renovate asset, and core no longer contributes any", () => {
    // The only owner of any `.github/**` or `renovate.json` output path is github-automation —
    // except Helm, which owns its own `deploy` workflow (`.github/workflows/helm.yml`) as part of
    // the deployment concern. Every other capability contributes none.
    for (const id of capabilityLocalIds) {
      for (const path of contributedPaths(id)) {
        if (!path.startsWith(".github/") && path !== "renovate.json") continue;
        const allowed =
          id === OWNER_LOCAL || (id === toLocalId("helm") && path === ".github/workflows/helm.yml");
        expect(allowed, `${id} must not contribute ${path}`).toBe(true);
      }
    }

    const owned = new Set(contributedPaths(OWNER));
    for (const path of AUTOMATION_OWNED_FILES) {
      expect(owned.has(path), `github-automation is missing ${path}`).toBe(true);
    }

    const core = new Set(contributedPaths("core"));
    for (const path of AUTOMATION_OWNED_FILES) {
      expect(core.has(path), `core must no longer ship ${path}`).toBe(false);
    }
  });

  test("an automation-free app contains no .github workflows or renovate config", () => {
    const selection = ["fastapi"];
    expect(closure(selection).has(OWNER_LOCAL)).toBe(false);
    for (const path of appFiles(selection)) {
      expect(
        path.startsWith(".github/") || path === "renovate.json",
        `automation-free app must not ship ${path}`,
      ).toBe(false);
    }
  });

  test("every CI job renders iff its capability is in the closure, and needs never dangles", () => {
    for (const selection of SELECTIONS) {
      const present = closure(selection);
      const workflow = parseCi(present);
      const jobs = Object.keys(workflow.jobs ?? {});
      const label = selection.join("+");

      for (const always of ALWAYS_JOBS) {
        expect(jobs.includes(always), `${label}: missing unconditional job ${always}`).toBe(true);
      }
      for (const [job, gates] of Object.entries(JOB_GATE)) {
        expect(jobs.includes(job), `${label}: ${job} present must track ${gates.join(" + ")}`).toBe(
          gates.every((gate) => present.has(toLocalId(gate))),
        );
      }

      // Every `needs:` edge points at a job that this selection actually rendered.
      for (const [job, spec] of Object.entries(workflow.jobs ?? {})) {
        const needs = Array.isArray(spec.needs) ? spec.needs : spec.needs ? [spec.needs] : [];
        for (const dep of needs) {
          expect(jobs.includes(dep), `${label}: ${job} needs missing job ${dep}`).toBe(true);
        }
      }
    }
  });

  test("no rendered CI job runs an nx target for a project absent from the selection", () => {
    for (const selection of SELECTIONS) {
      const rendered = renderCi(closure(selection));
      const projects = availableProjects(selection);
      for (const target of invokedTargets(rendered)) {
        const project = target.slice(0, target.indexOf(":"));
        expect(
          projects.has(project),
          `${selection.join("+")}: CI runs ${target} but project ${project} is not installed`,
        ).toBe(true);
      }
    }
  });

  test("deployment-gated CI steps reference only assets the closure generates", () => {
    // The end-to-end job runs docker-compose's smoke runbook against its compose root; the web jobs
    // build and test the web app. When the job renders, those files must exist in the app.
    const withCompose = ["tanstack-start", "fastapi", "postgres", "docker-compose", OWNER];
    const composeFiles = appFiles(withCompose);
    const composeRendered = renderCi(closure(withCompose));
    expect(composeRendered).toContain("bash tools/smoke.sh");
    expect(composeFiles.has("tools/smoke.sh"), "e2e names smoke.sh but it is not generated").toBe(
      true,
    );
    expect(
      composeFiles.has("deploy/compose/compose.yaml"),
      "e2e names the compose root but it is not generated",
    ).toBe(true);

    // An automation app without web renders neither web job, so nothing names apps/web.
    const noWeb = renderCi(closure([OWNER, "postgres"]));
    expect(noWeb).not.toContain("apps/web");
  });

  test("the CI carrier escapes every GitHub expression so Handlebars leaves it intact", () => {
    // A bare `${{ … }}` in a `.hbs` is consumed by Handlebars and blanked; the escaped `$\{{ … }}`
    // renders back to `${{ … }}`. Fail on any unescaped occurrence so a new expression is caught.
    const unescaped = [...CI_HBS.matchAll(/(?<!\\)\{\{/g)].filter(
      (m) => !CI_HBS.startsWith("{{#if (has ", m.index) && !CI_HBS.startsWith("{{/if}}", m.index),
    );
    expect(unescaped.map((m) => m.index)).toEqual([]);

    // And the rendered form is real: no Handlebars token and no stray backslash-escape survive.
    const rendered = renderCi(closure([...capabilityLocalIds]));
    expect(rendered.includes("{{#if"), "unresolved gate").toBe(false);
    expect(rendered.includes("\\{{"), "stray escape").toBe(false);
    expect(rendered).toContain("${{ secrets.MISTRAL_REGISTRY_TOKEN }}");
  });
});
