/**
 * The deployment init chain must hold together under every selection.
 *
 * `cli.commands` is populated by feature capabilities vendoring command modules; docker-compose owns
 * the Compose init manifest and the Helm slice the chart, each gating its entries with
 * `{{#if (has "…")}}`. A step may only `depends_on` a service that a selected capability defines,
 * and rendering the manifest is the only way to catch a dangling reference.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  capabilityLocalIds,
  closure,
  renderHbs,
  selectionClosures,
  toLocalId,
} from "../support/selection";
import { capabilityDir } from "../support/template-tree";

/** deploy-step command name -> owning capability's local id (only modules marked `INIT_STEP`). */
const stepOwner = new Map<string, string>();
for (const id of capabilityLocalIds) {
  const dir = join(
    capabilityDir(id),
    "template",
    "packages",
    "py",
    "cli",
    "src",
    "cli",
    "commands",
  );
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".py") && f !== "__init__.py")) {
    // Only deployment init steps are wired into the manifests; operator commands (eval-agents,
    // ingest, …) ship in `commands/` too but opt out by omitting the `INIT_STEP = True` marker.
    if (!/^INIT_STEP = True\b/m.test(readFileSync(join(dir, file), "utf8"))) continue;
    // Typer names a command after its module with `_` -> `-` (`custom_rbac` -> `custom-rbac`).
    stepOwner.set(file.slice(0, -3).replaceAll("_", "-"), id);
  }
}

// Shared services and integration-owned overlays together define the Compose service catalog.
const COMPOSE_OWNER = "docker-compose";
const COMPOSE_OWNER_LOCAL = toLocalId(COMPOSE_OWNER);
const COMPOSE_DIR = join(capabilityDir(COMPOSE_OWNER), "template", "deploy", "compose");

/** compose service name -> the capability whose selection contributes the defining overlay. */
const serviceOwner = new Map<string, string>();
for (const owner of capabilityLocalIds) {
  const composeDir = join(capabilityDir(owner), "template", "deploy", "compose");
  if (!existsSync(composeDir)) continue;
  for (const file of readdirSync(composeDir)) {
    // `.dev.` overlays only patch services the base files already declare.
    if (!/\.ya?ml(?:\.hbs)?$/.test(file) || file.includes(".dev.")) continue;
    for (const [, name] of readFileSync(join(composeDir, file), "utf8").matchAll(
      /^ {2}([a-z][a-z0-9-]*):$/gm,
    )) {
      if (!serviceOwner.has(name!)) serviceOwner.set(name!, owner);
    }
  }
}

const COMPOSE_SRC = readFileSync(join(COMPOSE_DIR, "compose.init.yaml.hbs"), "utf8");
const CHART_SRC = readFileSync(
  join(capabilityDir("helm"), "template", "deploy/helm/app/charts/init/values.yaml.hbs"),
  "utf8",
);

interface InitService {
  command?: string[] | string;
  depends_on?: Record<string, { condition?: string }> | string[];
}

/** The `init-*` services in the rendered compose, each with the step it runs and what it waits on. */
function composeSteps(present: Set<string>) {
  // SAFETY: compose.init.yaml is a repo-owned overlay; a shape mismatch fails the assertions below.
  const doc = Bun.YAML.parse(renderHbs(COMPOSE_SRC, present)) as {
    services?: Record<string, InitService>;
  };
  const steps = new Set<string>();
  const dependsOn = new Map<string, string[]>();
  for (const [name, service] of Object.entries(doc.services ?? {})) {
    const command = Array.isArray(service.command)
      ? service.command.join(" ")
      : (service.command ?? "");
    const step = command.match(/python -m cli (\S+)/);
    if (step) steps.add(step[1]!);
    const deps = service.depends_on;
    const depNames = Array.isArray(deps) ? deps : deps ? Object.keys(deps) : [];
    if (depNames.length > 0) dependsOn.set(name, depNames);
  }
  return { steps, dependsOn };
}

const chartSteps = (present: Set<string>) =>
  new Set(
    [...renderHbs(CHART_SRC, present).matchAll(/^ {2}- name: (\S+)\n {4}hookWeight:/gm)].map(
      (m) => m[1]!,
    ),
  );

describe("the init chain degrades by capability", () => {
  test.each(
    selectionClosures.map(({ label: caseLabel, present }) => [caseLabel, present] as const),
  )("%s runs exactly the deploy-step commands vendored for it", (_name, present) => {
    const expected = new Set(
      [...stepOwner].filter(([, owner]) => present.has(owner)).map(([step]) => step),
    );

    // Both manifests must list exactly the deploy-step commands (those marked `INIT_STEP`) whose
    // owner is present: a manifest step with no module dies on an unknown command, and a marked
    // command with no entry silently never runs. Operator commands (eval-agents, ingest, …) omit
    // the marker, so they are never expected here.
    expect([...composeSteps(present).steps].toSorted()).toEqual([...expected].toSorted());
    expect([...chartSteps(present)].toSorted()).toEqual([...expected].toSorted());
  });

  test.each(
    selectionClosures
      .filter(({ present }) => present.has(COMPOSE_OWNER_LOCAL))
      .map(({ label: caseLabel, present }) => [caseLabel, present] as const),
  )("%s waits only on services that exist", (_name, present) => {
    const { dependsOn } = composeSteps(present);
    // Services from the sibling overlays this file is `include:`d alongside count as defined,
    // but only when their own capability was selected.
    const available = new Set([
      ...dependsOn.keys(),
      ...[...serviceOwner].filter(([, owner]) => present.has(owner)).map(([name]) => name),
    ]);
    for (const [service] of dependsOn) available.add(service);

    const dangling = [...dependsOn].flatMap(([service, deps]) =>
      deps.filter((dep) => !available.has(dep)).map((dep) => `${service} -> ${dep}`),
    );

    expect(dangling).toEqual([]);
  });
});

// The per-app init tests (compose-owned test_compose_init_steps.py, helm-owned test_helm_init.py)
// each check only their own manifest against the vendored modules — neither can read the other's
// file, since a Compose-only or Helm-only app ships just one. The chart-vs-Compose ORDER agreement
// they used to assert together therefore lives here, the one place that renders both. The suites
// above pin each manifest to the same step SET per selection; this pins the two to the same step
// ORDER, so a hookWeight reshuffle or a moved Compose service cannot silently diverge the deploys.
// One selection per capability (its closure alone), plus the empty and full sets.
const SELECTIONS: string[][] = [[], ...capabilityLocalIds.map((id) => [id]), capabilityLocalIds];
const label = (selection: string[]) =>
  selection.length === 0 ? "(shell only)" : selection.length === 1 ? selection[0]! : "(everything)";

describe("the chart and compose agree on step order", () => {
  test.each(SELECTIONS.map((s) => [label(s), s] as const))(
    "%s lists the same steps in the same order in both manifests",
    (_name, selection) => {
      const present = closure(selection);
      const chartOrder = [
        ...renderHbs(CHART_SRC, present).matchAll(/^ {2}- name: (\S+)\n {4}hookWeight:/gm),
      ].map((m) => m[1]!);
      const composeOrder = [
        ...renderHbs(COMPOSE_SRC, present).matchAll(/python -m cli (\S+?)"/g),
      ].map((m) => m[1]!);
      expect(composeOrder).toEqual(chartOrder);
    },
  );
});
