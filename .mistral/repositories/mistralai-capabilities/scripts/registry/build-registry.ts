#!/usr/bin/env bun
/**
 * build-registry.ts — derive the repo-root `registry.json` descriptor (v3) from
 * `registry.config.json` and the `capabilities/<kind>/<id>/capability.json` scan.
 * `--check` runs in `framework-check.yaml` and fails the PR on a stale descriptor.
 *
 *   bun scripts/registry/build-registry.ts          # write registry.json
 *   bun scripts/registry/build-registry.ts --check  # fail if the committed file is stale
 *
 * This is the single canonical projection: a repo-local mirror of the reviewed
 * `mistral apps registry build` v3 emitter, byte-for-byte. It emits ONLY
 * descriptor version 3 — registry-defined selection kinds, explicit modules, and
 * fully qualified `registry/kind/id` references. The registry-local topology
 * invariant (every root at exactly `<kind>/<id>`) is enforced by the shared
 * discovery scan (`readManifests`), so there is no second validation walk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { syncGeneratedFiles } from "../shared/generated-files";
import {
  type CapabilityIdentity,
  ID_PATTERN,
  localCapabilityId,
  npmCapabilityName,
  pyCapabilityName,
  resolveCapabilityRef,
  uniqueCapabilityId,
} from "../shared/capability-identity";
import {
  type CapabilityManifest,
  type ActivationRule,
  type ModuleDeclaration,
  readManifests,
} from "../shared/manifests";
import { z } from "zod";

const root = process.cwd();
const DESCRIPTOR_PATH = join(root, "registry.json");

const ActivationRuleSchema = z.object({ allOf: z.array(z.string()).min(1) }).strict();

/** The CLI's route grammar: absolute, no trailing slash, each segment an id. */
const RoutePathSchema = z.string().refine(
  (path) =>
    path.startsWith("/") &&
    !path.endsWith("/") &&
    path
      .slice(1)
      .split("/")
      .every((segment) => ID_PATTERN.test(segment)),
  { message: 'route path must be an absolute normalized prefix other than "/" (e.g. "/mcp").' },
);

export const RouteDeclarationsSchema = z
  .array(z.object({ path: RoutePathSchema, mcp: z.boolean().optional() }).strict())
  .min(1)
  .refine((routes) => new Set(routes.map((route) => route.path)).size === routes.length, {
    message: "route paths must be unique.",
  });

/** The CLI's managed-database grammar: deploy only provisions Postgres. */
export const DatabaseDeclarationSchema = z
  .object({ engine: z.literal("postgres"), extensions: z.array(z.string().min(1)).optional() })
  .strict();

const PreStartCommandsSchema = z.array(z.string().min(1)).min(1);

/** The CLI's pre-start grammar: at least one phase, each a non-empty list of commands. */
export const PreStartDeclarationSchema = z
  .object({ dev: PreStartCommandsSchema.optional(), deploy: PreStartCommandsSchema.optional() })
  .strict()
  .refine((preStart) => preStart.dev !== undefined || preStart.deploy !== undefined, {
    message: "declare dev or deploy.",
  });
/** A registry-authored selection group, as declared in `registry.config.json`. */
interface KindDefinition {
  id: string;
  title: string;
  description?: string;
  weight: number;
  min: number;
  max?: number;
}

/** One capability row as it is serialized into the v3 descriptor. */
interface CapabilityV3 {
  id: string;
  version: string;
  kind: string;
  title?: string;
  description?: string;
  categories?: string[];
  required?: boolean;
  default?: boolean;
  visible?: boolean;
  module?: ModuleDeclaration;
  dependencies?: string[];
  activatedWhen?: { allOf: string[] };
  packages: string[];
  pyIndexPackages?: string[];
  compatibility?: Record<string, string[]>;
  docs?: string;
  envVars?: Record<string, string>;
}

/** The complete descriptor v3 envelope. */
interface DescriptorV3 {
  id: string;
  descriptorVersion: 3;
  sources: Record<string, string>;
  capabilitiesDir?: string;
  kinds: KindDefinition[];
  capabilities: CapabilityV3[];
}

/** Sorted, unique copy of a qualified-reference list (locale order). */
function sortedUnique(refs: readonly string[]): string[] {
  return [...new Set(refs)].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Qualify every source reference to a full `registry/kind/id` identity against
 * the registry's own capabilities, then de-duplicate and sort — the canonical
 * form the descriptor carries for a dependency or compatibility list.
 */
function qualifyRefs(
  refs: readonly string[],
  registryId: string,
  candidates: readonly CapabilityIdentity[],
): string[] {
  return sortedUnique(refs.map((ref) => resolveCapabilityRef(ref, registryId, candidates)));
}

/**
 * Serialize a compatibility map: keys lexicographic, values qualified+sorted+unique.
 * Every key must be a kind declared in `registry.config.json`, and each resolved
 * target's kind must equal its compatibility-map key — the same rules the CLI's
 * `descriptorV3Violations` enforces on the generated descriptor. Every resolved
 * reference is a full `registry/kind/id` (local refs qualified here, foreign full
 * refs passed through), so its `kind` segment is compared directly; foreign targets
 * are checked for key agreement only, never existence.
 */
function serializeCompatibility(
  compatibility: Record<string, string[]>,
  registryId: string,
  candidates: readonly CapabilityIdentity[],
  capKey: string,
  kindIds: ReadonlySet<string>,
) {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(compatibility).toSorted((a, b) => a.localeCompare(b))) {
    if (!kindIds.has(key)) {
      throw new Error(
        `capability \`${capKey}\` compatibility declares kind \`${key}\`, ` +
          `which is not declared in registry.config.json.`,
      );
    }
    const targets = qualifyRefs(compatibility[key] ?? [], registryId, candidates);
    for (const target of targets) {
      const targetKind = target.split("/").at(-2);
      if (targetKind !== key) {
        throw new Error(
          `capability \`${capKey}\` compatibility lists \`${target}\` under kind \`${key}\`, ` +
            `but that reference's kind is \`${targetKind}\`.`,
        );
      }
    }
    out[key] = targets;
  }
  return out;
}

/**
 * Validate the strict `activatedWhen` shape and return its raw source refs. The
 * rule must be a non-null, non-array object whose ONLY key is a non-empty
 * `allOf` array of strings — the exact conjunction contract, with no `anyOf`,
 * negation, or extra keys.
 */
function activationSourceRefs(activatedWhen: ActivationRule, capKey: string): string[] {
  const parsed = ActivationRuleSchema.safeParse(activatedWhen);
  if (!parsed.success) {
    throw new Error(
      `capability \`${capKey}\` \`activatedWhen\` must be an object containing only a non-empty string array \`allOf\`: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data.allOf;
}

/**
 * Qualify and validate a derived capability's `activatedWhen`. Every reference is
 * resolved to its canonical `registry/kind/id` identity (throwing on a malformed,
 * missing, or ambiguous ref), then rejected if it names the capability itself, is
 * duplicated within `allOf`, or is also declared as an ordinary dependency. The
 * returned `allOf` is unique and sorted — the canonical descriptor form.
 */
function qualifyActivation(
  activatedWhen: ActivationRule,
  registryId: string,
  candidates: readonly CapabilityIdentity[],
  capKey: string,
  ownId: string,
  dependencies: readonly string[],
) {
  const deps = new Set(dependencies);
  const seen = new Set<string>();
  for (const ref of activationSourceRefs(activatedWhen, capKey)) {
    const target = resolveCapabilityRef(ref, registryId, candidates);
    if (target === ownId) {
      throw new Error(
        `capability \`${capKey}\` \`activatedWhen\` references itself (\`${ref}\`); a capability cannot activate on itself.`,
      );
    }
    if (seen.has(target)) {
      throw new Error(
        `capability \`${capKey}\` \`activatedWhen.allOf\` lists \`${target}\` more than once; activation references must be unique.`,
      );
    }
    if (deps.has(target)) {
      throw new Error(
        `capability \`${capKey}\` lists \`${target}\` in both \`activatedWhen.allOf\` and \`dependencies\`; ` +
          `an activation prerequisite must not be duplicated as a dependency.`,
      );
    }
    seen.add(target);
  }
  return { allOf: [...seen].toSorted((a, b) => a.localeCompare(b)) };
}

/**
 * Project one v3 `capability.json` manifest into its canonical descriptor row,
 * in the CLI serializer's exact key order (no `path`): dependencies and
 * compatibility targets are qualified against `registryId` and the scanned
 * candidates, defaults are trimmed, and references are sorted. A manifest key the
 * v3 projection does not carry fails loudly.
 */
function projectEntryV3(
  manifest: CapabilityManifest,
  registryId: string,
  candidates: readonly CapabilityIdentity[],
  kindIds: ReadonlySet<string>,
  derivedIds: ReadonlySet<string>,
): CapabilityV3 {
  const KNOWN = {
    id: true,
    version: true,
    title: true,
    description: true,
    categories: true,
    default: true,
    required: true,
    dependencies: true,
    activatedWhen: true,
    visible: true,
    packages: true,
    pyIndexPackages: true,
    docs: true,
    envVars: true,
    kind: true,
    module: true,
    routes: true,
    database: true,
    preStart: true,
    compatibility: true,
    metadata: true,
    path: true,
  } satisfies Record<string, true>;
  const unknown = Object.keys(manifest).filter((key) => !Object.hasOwn(KNOWN, key));
  if (unknown.length > 0) {
    throw new Error(
      `capability \`${manifest.id}\` has descriptor field(s) the v3 projection does not handle: ${unknown.join(", ")}.`,
    );
  }
  if (!kindIds.has(manifest.kind)) {
    throw new Error(
      `capability \`${manifest.id}\` declares kind \`${manifest.kind}\`, which is not declared in registry.config.json.`,
    );
  }
  const categories = manifest.categories ?? [];
  const dependencies = qualifyRefs(manifest.dependencies ?? [], registryId, candidates);
  for (const dependency of dependencies) {
    if (derivedIds.has(dependency)) {
      throw new Error(
        `capability \`${localCapabilityId(manifest)}\` declares an ordinary dependency on derived capability \`${dependency}\`; ` +
          `a derived capability is entered through activation or direct shorthand selection, never a dependency edge.`,
      );
    }
  }
  const activatedWhen =
    manifest.activatedWhen !== undefined
      ? qualifyActivation(
          manifest.activatedWhen,
          registryId,
          candidates,
          localCapabilityId(manifest),
          uniqueCapabilityId(registryId, manifest),
          dependencies,
        )
      : undefined;
  z.boolean().optional().parse(manifest.visible);
  // Kept out of the descriptor: released CLIs parse its rows strictly and would reject the key.
  RouteDeclarationsSchema.optional().parse(manifest.routes);
  DatabaseDeclarationSchema.optional().parse(manifest.database);
  PreStartDeclarationSchema.optional().parse(manifest.preStart);
  return {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    title: manifest.title,
    description: manifest.description,
    categories: categories.length > 0 ? categories : undefined,
    required: manifest.required || undefined,
    default: manifest.default || undefined,
    visible: manifest.visible === false ? false : undefined,
    module: manifest.module,
    dependencies: dependencies.length > 0 ? dependencies : undefined,
    activatedWhen,
    packages: manifest.packages ?? [],
    pyIndexPackages:
      manifest.pyIndexPackages !== undefined && manifest.pyIndexPackages.length > 0
        ? manifest.pyIndexPackages
        : undefined,
    compatibility:
      manifest.compatibility !== undefined && Object.keys(manifest.compatibility).length > 0
        ? serializeCompatibility(
            manifest.compatibility,
            registryId,
            candidates,
            localCapabilityId(manifest),
            kindIds,
          )
        : undefined,
    docs: manifest.docs,
    envVars: manifest.envVars,
  };
}

/**
 * Reject two distinct capabilities that render the same published name for a
 * shared transport — `<kind>-<id>` npm scoping and PEP 503 python normalization
 * both flatten punctuation, so `a-b/c` and `a/b-c` would otherwise silently
 * fight over one package. Checked per transport a capability declares, naming
 * both full ids and the colliding name.
 */
function assertNoNameCollisions(caps: readonly CapabilityV3[], registryId: string): void {
  const transports: { lang: string; render: (id: CapabilityIdentity) => string }[] = [
    { lang: "ts", render: (id) => npmCapabilityName(registryId, id) },
    { lang: "py", render: (id) => pyCapabilityName(registryId, id) },
  ];
  for (const { lang, render } of transports) {
    const byName = new Map<string, CapabilityV3[]>();
    for (const cap of caps) {
      if (!cap.packages.includes(lang)) continue;
      const name = render(cap);
      const group = byName.get(name);
      if (group === undefined) byName.set(name, [cap]);
      else group.push(cap);
    }
    for (const [name, group] of byName) {
      if (group.length > 1) {
        const ids = group
          .map((cap) => uniqueCapabilityId(registryId, cap))
          .toSorted((a, b) => a.localeCompare(b));
        throw new Error(
          `${lang} package name \`${name}\` is rendered by more than one capability: ${ids.join(", ")}.`,
        );
      }
    }
  }
}

/**
 * Reject an activation cycle. Derived capabilities form a graph through the
 * derived capabilities among their `activatedWhen` prerequisites; a cycle there
 * is a set of mutually self-activating declarations that can never all become
 * independently effective, so it is a descriptor error caught before publication.
 */
function assertNoActivationCycles(caps: readonly CapabilityV3[], registryId: string): void {
  const activation = new Map<string, readonly string[]>();
  for (const cap of caps) {
    if (cap.activatedWhen !== undefined) {
      activation.set(uniqueCapabilityId(registryId, cap), cap.activatedWhen.allOf);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: readonly string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      throw new Error(
        `activation cycle detected: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}.`,
      );
    }
    state.set(id, "visiting");
    for (const ref of activation.get(id) ?? []) {
      if (activation.has(ref)) visit(ref, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const id of activation.keys()) visit(id, []);
}

/**
 * Serialise the descriptor exactly as the committed file is written. `repoRoot` defaults to the
 * process cwd (the CLI's caller) but is passed explicitly by callers that do not run from the repo
 * root, such as the registry freshness test.
 */
function buildDescriptor(
  repoRoot: string = process.cwd(),
  suppliedManifests?: readonly CapabilityManifest[],
): string {
  const configPath = join(repoRoot, "registry.config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `${configPath} is missing; the descriptor's non-derivable \`id\`/\`sources\`/\`kinds\` have no source.`,
    );
  }
  const configSchema = z.object({
    id: z.string(),
    sources: z.record(z.string(), z.string()),
    kinds: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string().optional(),
          weight: z.number(),
          min: z.number(),
          max: z.number().optional(),
        }),
      )
      .optional(),
    capabilitiesDir: z.string().optional(),
  });
  const config = configSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  if (config.kinds === undefined || config.kinds.length === 0) {
    throw new Error(
      `${configPath} declares no \`kinds\`; descriptor v3 requires at least one selection kind.`,
    );
  }

  const manifests = suppliedManifests ?? readManifests(repoRoot, config.capabilitiesDir);
  const candidates: CapabilityIdentity[] = manifests.map(({ kind, id }) => ({ kind, id }));
  const kindIds = new Set(config.kinds.map((kind) => kind.id));
  const derivedIds = new Set(
    manifests
      .filter((manifest) => manifest.activatedWhen !== undefined)
      .map((manifest) => uniqueCapabilityId(config.id, manifest)),
  );

  const capabilities = manifests
    .map((manifest) => projectEntryV3(manifest, config.id, candidates, kindIds, derivedIds))
    .toSorted((a, b) =>
      uniqueCapabilityId(config.id, a).localeCompare(uniqueCapabilityId(config.id, b)),
    );
  assertNoNameCollisions(capabilities, config.id);
  assertNoActivationCycles(capabilities, config.id);

  const kinds: KindDefinition[] = [...config.kinds]
    .toSorted((a, b) => a.weight - b.weight || a.id.localeCompare(b.id))
    .map((kind) => ({
      id: kind.id,
      title: kind.title,
      description: kind.description,
      weight: kind.weight,
      min: kind.min,
      max: kind.max,
    }));
  const descriptor: DescriptorV3 = {
    id: config.id,
    descriptorVersion: 3,
    sources: config.sources,
    capabilitiesDir:
      config.capabilitiesDir !== undefined && config.capabilitiesDir !== "capabilities"
        ? config.capabilitiesDir
        : undefined,
    kinds,
    capabilities,
  };
  // The reviewed `registry build` writes the v3 descriptor with a plain 2-space body and a single
  // trailing newline (its `writeJson`), leaving non-ASCII verbatim — match it byte for byte.
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  // buildDescriptor throws so it stays a reusable library (an importing test fails one case
  // rather than killing the runner); the CLI is the only place that turns that into an exit code.
  let fresh: boolean;
  try {
    fresh = await syncGeneratedFiles(
      [{ path: DESCRIPTOR_PATH, generate: () => buildDescriptor(root) }],
      check,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // A stale descriptor means someone changed a `capability.json` without regenerating, the exact
  // drift class that had no guard before.
  if (!fresh) process.exit(1);
  if (check) console.log("registry.json is up to date.");
}

// Only run when executed directly. Importing (for example from pack-all.ts)
// just loads `buildDescriptor` without touching the filesystem.
if (import.meta.main) {
  await main();
}

export { buildDescriptor };
