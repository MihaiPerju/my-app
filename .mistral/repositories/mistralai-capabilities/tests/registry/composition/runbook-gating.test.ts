/**
 * The local runbooks the app ships (the k3d capability's deploy script and values fixture, and the
 * docker-compose capability's smoke test) must degrade when an optional module is deselected, like
 * the Helm chart and compose includes do via
 * `{{#if (has "…")}}`. A small renderer resolves the subset for a selection, and each check asserts
 * a module's operations appear when the module is selected and vanish when it is not. `k3d` owns its
 * local-cluster helpers and values overlay; `docker-compose` owns the compose smoke test.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderHbs } from "../support/selection";
import { capabilityDir } from "../support/template-tree";

const K3D = join(capabilityDir("k3d"), "template");
const readK3d = (rel: string) => readFileSync(join(K3D, rel), "utf8");

// Optional (default-but-deselectable) capabilities. Auth keeps the gateway checks present while
// module-specific checks remain gated independently.
const ALL = [
  "auth",
  "docker-compose-auth",
  "fastapi",
  "tanstack-start",
  "workflows",
  "postgres",
  "chat",
  "speech",
] as const;
const allSet = new Set<string>(ALL);
const without = (m: string) => new Set([...ALL].filter((x) => x !== m));

const countOccurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("k3d-up.sh degrades by module", () => {
  const src = readK3d("tools/k3d-up.sh.hbs");
  const line = (present: Set<string>, prefix: string) =>
    renderHbs(src, present)
      .split("\n")
      .find((l) => l.startsWith(prefix))!;

  test("the built/imported SERVICES list gates each app service", () => {
    for (const [capability, service] of [
      ["fastapi", "api"],
      ["tanstack-start", "web"],
      ["workflows", "workflows"],
    ] as const) {
      const word = new RegExp(`\\b${service}\\b`);
      expect(line(allSet, "SERVICES="), `SERVICES lists ${service} when selected`).toMatch(word);
      expect(
        line(without(capability), "SERVICES="),
        `SERVICES drops ${service} when deselected`,
      ).not.toMatch(word);
    }
  });

  test("the rollout wait gates app services but always keeps core-owned gateway", () => {
    for (const [capability, service] of [
      ["fastapi", "api"],
      ["tanstack-start", "web"],
      ["workflows", "workflows"],
    ] as const) {
      const word = new RegExp(`\\b${service}\\b`);
      expect(line(allSet, "for d in ")).toMatch(word);
      expect(line(without(capability), "for d in ")).not.toMatch(word);
    }
    expect(line(without("fastapi"), "for d in "), "gateway stays in the rollout list").toMatch(
      /\bgateway\b/,
    );
  });

  test("the postgres statefulset wait is gated on postgres", () => {
    expect(renderHbs(src, allSet)).toContain("statefulset/$RELEASE-postgres");
    expect(renderHbs(src, without("postgres"))).not.toContain("statefulset/$RELEASE-postgres");
  });

  test("no Go-template braces remain (they cannot survive a .hbs render)", () => {
    // The old `docker info --format '{{.Architecture}}'` was replaced by `uname -m`.
    expect(src).not.toMatch(/\{\{[-\s]*\./);
    expect(src).toContain("uname -m");
  });
});

describe("values-local.yaml degrades by module", () => {
  const src = readK3d("deploy/k3d/values-local.yaml.hbs");
  const hasLine = (present: Set<string>, exact: string) =>
    renderHbs(src, present)
      .split("\n")
      .some((l) => l === exact);

  test("each per-subchart override block is gated; init stays (core-owned)", () => {
    for (const [m, header] of [
      ["fastapi", "api:"],
      ["tanstack-start", "web:"],
      ["workflows", "workflows:"],
      ["postgres", "  postgres:"], // the global.postgres override block
    ] as const) {
      expect(hasLine(allSet, header), `${header} present when ${m} selected`).toBe(true);
      expect(hasLine(without(m), header), `${header} dropped when ${m} deselected`).toBe(false);
    }
    expect(hasLine(without("fastapi"), "init:"), "init is always present").toBe(true);
  });
});

describe("smoke.sh degrades by module", () => {
  const src = readFileSync(
    join(capabilityDir("docker-compose"), "template", "tools", "smoke.sh.hbs"),
    "utf8",
  );
  const r = (present: Set<string>) => renderHbs(src, present);

  // Each needle is an operation that would emit a FAIL row against a service that isn't in the
  // stack. `|| true` only stops `set -e`; it does not suppress the recorded FAIL, so the call
  // itself has to be gated.
  const cases: Array<[string, string[]]> = [
    ["workflows", ["wait_compose_healthy workflows", "discover_all_workflows_in_package"]],
    ["postgres", ["wait_compose_healthy postgres"]],
    ["fastapi", ["wait_compose_healthy api"]],
    ["tanstack-start", ["wait_compose_healthy web"]],
    ["chat", ['"/chat"']],
  ];

  test("module-specific checks appear only when the module is selected", () => {
    for (const [m, needles] of cases) {
      for (const needle of needles) {
        expect(r(allSet), `${m}: "${needle}" present when selected`).toContain(needle);
        expect(r(without(m)), `${m}: "${needle}" gone when deselected`).not.toContain(needle);
      }
    }
  });

  test("the web_routes step is invoked only when web is selected", () => {
    // The function is always defined; only its call site in main() is gated.
    expect(countOccurrences(r(allSet), "step_web_routes")).toBe(2);
    expect(countOccurrences(r(without("tanstack-start")), "step_web_routes")).toBe(1);
  });

  test("auth-owned gateway and shared init checks are present in the full composition", () => {
    expect(r(without("fastapi"))).toContain("wait_compose_healthy gateway");
    expect(r(without("workflows"))).toContain("wait_compose_completed init");
  });

  test("no Go-template braces remain in the rewritten compose helpers", () => {
    expect(src).not.toMatch(/\{\{[-\s]*\./);
    expect(src).toContain("--format json");
  });
});
