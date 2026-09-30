/**
 * The centralized Helm chart lints and renders for the closures a real selection produces.
 *
 * The visible `helm` capability owns shared chart infrastructure; hidden `helm-*` integrations own
 * service subcharts. These fixtures compose every selected capability's `deploy/helm/app` subtree
 * the way the CLI does — `.hbs` files through the `{{#if (has …)}}` gate plus the `projectName`
 * substitution, every other file verbatim — for representative closures, then run `helm lint` and
 * `helm template` against the result. A chart that only ever renders under the full catalogue would
 * hide the gaps that appear when a module (web, workflows, postgres) is absent; each closure below
 * asserts the rendered workloads match exactly the selected runtimes.
 *
 * `helm` is not always on a dev box or in CI, so the suite skips (rather than fails) when the binary
 * is missing — the same posture the e2e takes for its chart checks.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { closure, renderHbs } from "../support/selection";
import { capabilityDir, contributedPaths, walk } from "../support/template-tree";

const HELM_BIN = Bun.which("helm");
const CHART_REL = join("template", "deploy", "helm", "app");
const HELM_TEST_TIMEOUT_MS = 30_000;

/** Compose and render the chart contributed by a selection closure into a throwaway directory. */
function renderChart(present: Set<string>, projectName: string): string {
  const dest = mkdtempSync(join(tmpdir(), "helm-fixture-"));
  for (const owner of [...present].toSorted()) {
    const chartSrc = join(capabilityDir(owner), CHART_REL);
    if (!existsSync(chartSrc)) continue;
    for (const file of walk(chartSrc)) {
      const rel = relative(chartSrc, file);
      let outRel = rel;
      let content = readFileSync(file, "utf8");
      if (rel.endsWith(".hbs")) {
        content = renderHbs(content, present).replaceAll("{{projectName}}", projectName);
        outRel = rel.slice(0, -".hbs".length);
      }
      const out = join(dest, outRel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, content);
    }
  }
  return dest;
}

/** `helm template` the rendered closure without asserting success, for render-time guards. */
function helmTemplateRaw(present: Set<string>, extraArgs: string[] = []) {
  const dir = renderChart(present, "fixture-app");
  try {
    return spawnSync(HELM_BIN!, ["template", "release", dir, ...extraArgs], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `helm template` the rendered closure, asserting a clean render, and return its manifests. */
function helmTemplate(present: Set<string>, extraArgs: string[] = []): string {
  const dir = renderChart(present, "fixture-app");
  try {
    const lint = spawnSync(HELM_BIN!, ["lint", dir], { encoding: "utf8" });
    expect(lint.status, `helm lint failed:\n${lint.stdout}\n${lint.stderr}`).toBe(0);
    const rendered = spawnSync(HELM_BIN!, ["template", "release", dir, ...extraArgs], {
      encoding: "utf8",
    });
    expect(rendered.status, `helm template failed:\n${rendered.stdout}\n${rendered.stderr}`).toBe(
      0,
    );
    return rendered.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The distinct `app.kubernetes.io/component` labels in a rendered manifest stream, sorted. */
const componentsOf = (manifests: string): string[] =>
  [
    ...new Set(
      [...manifests.matchAll(/app\.kubernetes\.io\/component:\s*(\S+)/g)].map((m) => m[1]!),
    ),
  ].toSorted();

describe("Helm chart renders per selection closure", () => {
  // A tooling-/deployment-free app selects no `helm`, so it must receive no chart at all. Runtime,
  // database, and base capabilities remain deployment-agnostic; only Helm and its hidden
  // integrations may carry `deploy/helm` assets. This holds with or without a `helm` binary.
  test("runtime capabilities contribute no deploy/helm assets", () => {
    const strays: string[] = [];
    for (const id of ["core", "fastapi", "tanstack-start", "workflows", "postgres"]) {
      for (const path of contributedPaths(id)) {
        if (path.startsWith("deploy/helm")) strays.push(`${id}: ${path}`);
      }
    }
    expect(strays, "these capabilities leak Helm assets into a deployment-free app").toEqual([]);
  });

  describe.skipIf(!HELM_BIN)("with the helm binary", () => {
    test(
      "the API/web/auth closure renders api, web, gateway and init",
      () => {
        const components = componentsOf(
          helmTemplate(closure(["fastapi", "auth", "tanstack-start", "helm"])),
        );
        expect(components).toContain("api");
        expect(components).toContain("web");
        expect(components).toContain("gateway");
        expect(components.some((c) => c.startsWith("init-"))).toBe(true);
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "an API-only closure renders no web workload",
      () => {
        const present = closure(["fastapi", "auth", "helm"]);
        const components = componentsOf(helmTemplate(present));
        expect(components).toContain("api");
        expect(components).toContain("gateway");
        expect(components).not.toContain("web");
        expect(helmTemplate(present)).not.toContain("- /mcp");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "the database closure renders the in-cluster postgres when deploy is enabled",
      () => {
        const components = componentsOf(
          helmTemplate(closure(["fastapi", "postgres", "helm"]), [
            "--set",
            "global.postgres.deploy=true",
          ]),
        );
        expect(components).toContain("postgres");
        expect(components).toContain("api");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "the postgres subchart stays out of the render unless explicitly deployed",
      () => {
        const components = componentsOf(
          helmTemplate(closure(["fastapi", "tanstack-start", "helm"])),
        );
        expect(components).not.toContain("postgres");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "a feature closure (chat) pulls its runtimes and gated init steps into the chart",
      () => {
        const components = componentsOf(helmTemplate(closure(["chat", "helm"])));
        expect(components).toContain("api");
        expect(components).toContain("web");
        expect(components).toContain("workflows");
        // chat's closure selects the agents init step; migrations always run with postgres present.
        expect(components).toContain("init-agents");
        expect(components).toContain("init-migrations");
        expect(helmTemplate(closure(["chat", "helm"]))).toContain("- /mcp");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "a feature closure without a frontend (search) renders no web workload",
      () => {
        const components = componentsOf(helmTemplate(closure(["search", "helm"])));
        expect(components).toContain("api");
        expect(components).toContain("workflows");
        expect(components).not.toContain("web");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "custom-rbac bootstrap admins reach both the init Job and the API from one global value",
      () => {
        const manifests = helmTemplate(closure(["custom-rbac", "helm"]), [
          "--set",
          "global.customRbac.bootstrapAdmins=boss@x.io",
        ]);
        const docs = manifests.split(/^---$/m);
        for (const component of ["api", "init-custom-rbac"]) {
          const doc = docs.find(
            (d) =>
              /^kind: (Deployment|Job)$/m.test(d) &&
              d.includes(`app.kubernetes.io/component: ${component}`),
          );
          expect(doc, `no ${component} manifest`).toBeDefined();
          expect(doc).toMatch(/name: CUSTOM_RBAC_BOOTSTRAP_ADMINS\s+value: "boss@x\.io"/);
        }
        const others = docs.filter(
          (d) =>
            /^kind: (Deployment|Job)$/m.test(d) &&
            !/app\.kubernetes\.io\/component: (api|init-custom-rbac)$/m.test(d),
        );
        expect(others.length).toBeGreaterThan(0);
        for (const doc of others) expect(doc).not.toContain("CUSTOM_RBAC_BOOTSTRAP_ADMINS");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "an API on the allow_all custom-rbac policy refuses to render",
      () => {
        const result = helmTemplateRaw(closure(["custom-rbac", "helm"]), [
          "--set",
          "api.env.CUSTOM_RBAC_POLICY=allow_all",
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("allow_all");
      },
      HELM_TEST_TIMEOUT_MS,
    );

    test(
      "repeated generation of the same closure is byte-identical",
      () => {
        const present = closure(["fastapi", "tanstack-start", "helm"]);
        expect(helmTemplate(present)).toBe(helmTemplate(present));
      },
      HELM_TEST_TIMEOUT_MS,
    );
  });
});
