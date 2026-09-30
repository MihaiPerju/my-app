/**
 * The full compose project must hold together under every selection that installs it.
 *
 * Shared Compose roots are owned by `docker-compose`; optional overlays are owned by derived
 * integration capabilities. This suite renders each root's `include:` list, merges every included
 * overlay the way docker compose does, and asserts no service `depends_on` a service the merged
 * project never defines.
 *
 * The failure this guards against is real: an overlay is a plain file the CLI copies verbatim (or
 * renders when `.hbs`), so an include or cross-capability `depends_on` gated on the wrong effective
 * capability becomes dangling as soon as that integration is absent.
 *
 * Sibling to init-gating.test.ts (the `init` overlay's steps) and apisix-gating.test.ts (the
 * gateway route table).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { capabilityLocalIds, capabilityDir } from "../support/template-tree";
import { closure, renderHbs, selectionClosures, toLocalId } from "../support/selection";

// The capability that owns the Compose roots and shared overlays.
const COMPOSE_OWNER = "docker-compose";
const COMPOSE_OWNER_LOCAL = toLocalId(COMPOSE_OWNER);

// The two files docker is pointed AT, rather than overlays pulled in by name.
const ROOT_ENTRYPOINTS = new Set(["compose.yaml", "compose.dev.yaml"]);

const COMPOSE_DIR = join(capabilityDir(COMPOSE_OWNER), "template", "deploy", "compose");

interface Overlay {
  readonly src: string;
  readonly gates: readonly string[];
}

const AUTH_OVERLAY_EXTRA_GATE = new Map([
  ["compose.api.auth.dev.yaml", toLocalId("docker-compose-api")],
  ["compose.web.auth.yaml", toLocalId("docker-compose-web")],
  ["compose.web.auth.dev.yaml", toLocalId("docker-compose-web")],
]);

const overlays = new Map<string, Overlay>();
for (const owner of capabilityLocalIds) {
  const composeDir = join(capabilityDir(owner), "template", "deploy", "compose");
  if (!existsSync(composeDir)) continue;
  for (const file of readdirSync(composeDir)) {
    if (!/\.ya?ml(?:\.hbs)?$/.test(file)) continue;
    const rendered = file.endsWith(".hbs") ? file.slice(0, -".hbs".length) : file;
    if (ROOT_ENTRYPOINTS.has(rendered)) continue;
    const gates = [owner];
    const extraGate = AUTH_OVERLAY_EXTRA_GATE.get(rendered);
    if (extraGate !== undefined) gates.push(extraGate);
    overlays.set(rendered, { src: join(composeDir, file), gates });
  }
}

// The two root files are what docker compose is actually pointed at; each gates its own `include:`
// list. `compose.yaml` is the prod stack, `compose.dev.yaml` the hot-reload one.
const ROOT_FILES = {
  prod: readFileSync(join(COMPOSE_DIR, "compose.yaml.hbs"), "utf8"),
  dev: readFileSync(join(COMPOSE_DIR, "compose.dev.yaml.hbs"), "utf8"),
} as const;

interface ComposeService {
  depends_on?: string[] | Record<string, { condition?: string }>;
}
type RawComposeInclude = string | { path?: string | string[] };

interface RawComposeDoc {
  include?: RawComposeInclude[];
  services?: Record<string, ComposeService>;
}

// SAFETY: rendered is a repo-owned compose document. Callers validate required shapes below.
const parse = (rendered: string): RawComposeDoc => Bun.YAML.parse(rendered) as RawComposeDoc;

function isShortInclude(entry: RawComposeInclude): entry is string {
  return typeof entry === "string";
}

/** Normalize Compose's supported short and long include forms from parsed YAML. */
const includedFiles = (rendered: string): string[] =>
  (parse(rendered).include ?? []).flatMap((entry) => {
    if (isShortInclude(entry)) return [entry];
    if (entry.path === undefined) return [];
    return Array.isArray(entry.path) ? entry.path : [entry.path];
  });

/** Normalize compose's two `depends_on` forms (short list or long map) to a list of names. */
const dependsOn = (service: ComposeService): string[] =>
  Array.isArray(service.depends_on)
    ? service.depends_on
    : service.depends_on
      ? Object.keys(service.depends_on)
      : [];

// Compose is only present when docker-compose is installed, so every selection below carries it.
// Beyond that: the compose stack alone, each service capability with it, and everything.
const SELECTIONS: string[][] = [
  [COMPOSE_OWNER_LOCAL],
  ...capabilityLocalIds
    .filter((id) => id !== COMPOSE_OWNER_LOCAL)
    .map((id) => [COMPOSE_OWNER_LOCAL, id]),
  capabilityLocalIds.includes(COMPOSE_OWNER_LOCAL)
    ? capabilityLocalIds
    : [COMPOSE_OWNER_LOCAL, ...capabilityLocalIds],
];
const label = (selection: string[]) =>
  selection.length === 1
    ? "(compose only)"
    : selection.length >= capabilityLocalIds.length
      ? "(everything)"
      : selection.join("+");
describe("the compose project holds together by capability", () => {
  for (const [topo, rootSrc] of Object.entries(ROOT_FILES)) {
    test.each(
      selectionClosures
        .filter(({ present }) => present.has(COMPOSE_OWNER_LOCAL))
        .map(({ label: caseLabel, present }) => [caseLabel, present] as const),
    )(`${topo}: %s waits only on services the merged project defines`, (caseLabel, present) => {
      const defined = new Set<string>();
      const edges: [string, string][] = [];
      const missingIncludes: string[] = [];

      for (const file of includedFiles(renderHbs(rootSrc, present))) {
        const src = overlays.get(file)?.src;
        if (!src) {
          // The root `include:`s a file no capability ships — a dangling include in its own right.
          missingIncludes.push(file);
          continue;
        }
        const doc = parse(renderHbs(readFileSync(src, "utf8"), present));
        for (const [name, service] of Object.entries(doc.services ?? {})) {
          defined.add(name);
          for (const dep of dependsOn(service)) edges.push([name, dep]);
        }
      }

      expect(missingIncludes, `${topo} ${caseLabel}: unshipped include`).toEqual([]);

      const dangling = edges
        .filter(([, dep]) => !defined.has(dep))
        .map(([service, dep]) => `${service} -> ${dep}`);
      expect(dangling, `${topo} ${caseLabel}: dangling depends_on`).toEqual([]);
    });
  }
});

// The suite above only inspects overlays a root actually `include:`s, so it says nothing about an
// overlay shipped but never pulled in. Most overlays require their owner; auth augmentations also
// require the service they extend. Verify those complete gate sets across representative selections
// so roots neither omit vendored overlays nor include files that are absent from the composition.
describe("every compose overlay is wired into a root include", () => {
  const includeUnion = (present: Set<string>): Set<string> => {
    const files = new Set<string>();
    for (const rootSrc of Object.values(ROOT_FILES)) {
      for (const file of includedFiles(renderHbs(rootSrc, present))) files.add(file);
    }
    return files;
  };

  // Compose-present selections: compose alone, each service capability with it, its largest
  // gate-absent stack (every other capability whose closure does not pull the gate back in), and
  // everything. The gate-absent stacks surface an include mis-gated on a *different* optional
  // capability: the gate is out while its potential mis-gate targets are in.
  const serviceGates = [...new Set([...overlays.values()].flatMap((o) => o.gates))].filter(
    (gate) => gate !== COMPOSE_OWNER_LOCAL,
  );
  const matrixSelections: Array<readonly [string, string[]]> = [
    ...SELECTIONS.map((s) => [label(s), s] as const),
    ...serviceGates.map((absent): readonly [string, string[]] => [
      `(largest stack without ${absent})`,
      [COMPOSE_OWNER_LOCAL, ...capabilityLocalIds.filter((c) => !closure([c]).has(absent))],
    ]),
  ];

  test.each(matrixSelections)(
    "%s include:s exactly the overlays whose gate is in its closure",
    (name, selection) => {
      const present = closure(selection);
      const included = includeUnion(present);
      const mismatches: string[] = [];
      for (const [file, { gates }] of overlays) {
        const expected = gates.every((gate) => present.has(gate));
        if (included.has(file) === expected) continue;
        mismatches.push(
          expected
            ? `${file} missing though gates ${gates.join(", ")} are installed`
            : `${file} include:d without gates ${gates.join(", ")}`,
        );
      }
      expect(mismatches, `${name}: overlay include vs gate`).toEqual([]);
    },
  );
});

// Compose output is restricted to the shared owner and its derived integrations.
describe("compose output has an integration owner", () => {
  test("only docker-compose and its integrations ship compose files", () => {
    const expectedOwners = new Set([
      COMPOSE_OWNER_LOCAL,
      ...["api", "auth", "web", "workflows", "postgres", "bucket"].map((id) =>
        toLocalId(`docker-compose-${id}`),
      ),
    ]);
    const actualOwners = capabilityLocalIds.filter((id) =>
      existsSync(join(capabilityDir(id), "template", "deploy", "compose")),
    );
    expect(new Set(actualOwners)).toEqual(expectedOwners);
  });
});
