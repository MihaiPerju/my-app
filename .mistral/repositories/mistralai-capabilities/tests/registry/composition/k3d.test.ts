/**
 * The `k3d` capability is a thin, Helm-dependent local-cluster concern: selecting it must expand
 * `helm` (and therefore `core`) and `api` (and therefore `postgres`) transitively and produce a
 * runnable local-cluster shape that reuses the umbrella chart rather than duplicating it.
 * It depends on `fastapi` because `k3d-up` unconditionally deploys `init` on the API image and probes
 * `/api/health`, so that runtime must always be in the closure. It does NOT depend on `web`: the
 * `/` login-redirect smoke check is gated on the `web` runtime, so a `k3d`+`fastapi` selection still
 * stands the cluster up and smoke-tests the API.
 *
 * These checks are structural — they resolve the selection closure and the paths each capability
 * contributes to a generated app, the same model the CLI installs — so they hold with no cluster,
 * `helm`, or `k3d` binary present. The chart itself is lint/rendered by `helm-render.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilities, closure, renderHbs, toLocalId } from "../support/selection";
import { capabilityDir, contributedPaths } from "../support/template-tree";

describe("k3d local-cluster capability", () => {
  test("depends on Helm, FastAPI and auth and expands their closure", () => {
    expect(capabilities.get(toLocalId("k3d"))?.dependencies).toEqual(["helm", "fastapi", "auth"]);
    const resolved = closure(["k3d"]);
    for (const id of [
      "k3d",
      "helm",
      "core",
      "fastapi",
      "auth",
      "postgres",
      "k3d-auth",
      "helm-auth",
    ]) {
      expect(resolved.has(toLocalId(id)), `selecting k3d must install ${id}`).toBe(true);
    }
    // `web` is not required by a bare k3d selection; the web login-redirect smoke is gated on it.
    expect(
      resolved.has(toLocalId("tanstack-start")),
      "k3d must not pull web into a bare selection",
    ).toBe(false);
  });

  test("k3d is optional (not required, not a default pick)", () => {
    const k3d = capabilities.get(toLocalId("k3d"))!;
    expect(k3d.required ?? false).toBe(false);
    expect(k3d.default ?? false).toBe(false);
    expect(k3d.kind).toBe("deployment");
    expect(k3d.packages ?? []).toEqual([]); // template-only, git-delivered
  });

  test("ships only generic local-cluster assets; k3d-auth owns identity resources", () => {
    const owned = contributedPaths("k3d");
    expect(owned.toSorted()).toEqual([
      ".agents/skills/capability-k3d/SKILL.md",
      "deploy/k3d/values-local.yaml",
      "tasks/k3d/project.json",
      "tests/test_k3d_tasks.py",
      "tools/k3d-down.sh",
      "tools/k3d-up.sh",
    ]);
    // Chart, module adapters, runtime Dockerfiles, and application source are reused from `helm` and
    // the runtime capabilities — never owned here, so none of these prefixes may appear.
    const duplicated = owned.filter(
      (rel) =>
        rel.startsWith("deploy/helm/") ||
        rel.startsWith("deploy/docker/") ||
        rel.startsWith("apps/") ||
        rel.startsWith("packages/"),
    );
    expect(duplicated).toEqual([]);
  });

  test("k3d-up reuses the helm chart the closure already installs, with no dangling paths", () => {
    // A representative API/web/workflows/postgres closure with k3d selected.
    const present = closure(["fastapi", "tanstack-start", "workflows", "postgres", "k3d"]);
    const installed = new Set([...present].flatMap((id) => contributedPaths(id)));

    // The chart k3d-up deploys is owned by helm, not k3d, and is present in the closure.
    expect(
      installed.has("deploy/helm/app/Chart.yaml"),
      "helm chart is installed by the closure",
    ).toBe(true);

    // Every static `$REPO_ROOT/...` path the rendered runbook touches resolves to an installed file,
    // so the generated local-cluster shape has no dangling reference.
    const src = readFileSync(
      join(capabilityDir("k3d"), "template", "tools", "k3d-up.sh.hbs"),
      "utf8",
    );
    const rendered = renderHbs(src, present);
    const referenced = [...rendered.matchAll(/\$REPO_ROOT\/([A-Za-z0-9._/$-]+)/g)]
      .map((m) => m[1]!)
      // Drop shell-variable interpolations like Dockerfile.$svc — those expand per selected service,
      // asserted separately below.
      .filter((rel) => !rel.includes("$"))
      // `mistral apps init` writes the root `.env` from the capabilities' envVars; no template ships it.
      .filter((rel) => rel !== ".env");
    for (const rel of new Set(referenced)) {
      // A reference resolves if it is an installed file or a directory prefix of one (the chart is
      // referenced as the `deploy/helm/app` directory, not a single file).
      const resolved = installed.has(rel) || [...installed].some((p) => p.startsWith(`${rel}/`));
      expect(resolved, `k3d-up references ${rel}, which nothing installs`).toBe(true);
    }

    // Each Python service builds its own image; web retains its frontend-specific Dockerfile.
    for (const path of [
      "deploy/docker/Dockerfile.api",
      "deploy/docker/Dockerfile.worker",
      "deploy/docker/Dockerfile.web",
    ]) {
      expect(installed.has(path), `${path} is installed`).toBe(true);
    }
  });
});
