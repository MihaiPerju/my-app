/**
 * shared/manifests.ts — the one canonical scan and parse of the capability manifests.
 *
 * `build-registry.ts` (the descriptor), `build-docs.ts` (the README table), and
 * the registry tests all need the same things: the sorted list of capability
 * root LOCATIONS, the parsed `capability.json` manifests, and the topology
 * invariant. They read them through here so those cannot drift into three
 * loosely typed copies that disagree about the model or the validation.
 *
 * Every capability root lives at exactly `capabilities/<kind>/<id>` — depth two,
 * both path segments equal to the manifest's `kind` and `id`. The scan walks the
 * tree recursively (never descending into a directory that already holds a
 * `capability.json`) and rejects a shallow, over-nested, or mis-grouped root as
 * a topology error, so discovery and the topology invariant are one pass. The
 * discovered `<kind>/<id>` location is reported as each root's `path` and carried
 * on every manifest; it is DISCOVERED from the tree, never authored.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

/** Any value a `capability.json` field can hold — arbitrary decoded JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The registry-internal `metadata` block. Dropped from the descriptor by `build-registry`. */
export type CapabilityMetadata = MetadataFields &
  (
    | { build?: BuildDeclaration & { target: string }; platform?: undefined }
    | {
        build?: BuildDeclaration;
        /** Deploy runs the module as a managed workflow deployment. */
        platform: "workflows";
      }
  );

interface MetadataFields {
  /** Display/selection ordering; lower comes first. */
  weight?: number;
  /** Publication eligibility input; validated by the publication hard gate. */
  public?: unknown;
  /**
   * The template files (relative to `template/`) that carry registry connection state, each
   * projected per index by its `app-registry-pins.ts` projector. Listing them per carrier keeps a
   * projector from running on an unrelated file that happens to share a path.
   */
  registryPins?: readonly string[];
  /**
   * The app module directory this capability belongs to, e.g. `apps/api`. A capability that
   * declares `routes` but no `module` needs it when its template writes to more than one app.
   */
  appDir?: string;
}

/**
 * How deploy builds a capability's module; the CLI copies it onto the module in apps.json. Paths
 * are relative to the app root. `target` is the Dockerfile stage to build, and the last stage when
 * absent. Only a workflows worker leaves it out, because its managed build cannot pick one.
 */
export interface BuildDeclaration {
  context?: string;
  dockerfile: string;
  target?: string;
}

/**
 * The explicit runtime module a capability declares in descriptor v3,
 * discriminated by serve variant. A `static`/`server` module carries an
 * absolute normalized `route` prefix and explicit `browser` ownership; a
 * `worker` module carries neither. Its absence on a manifest means the
 * capability produces no app module.
 */
export type ModuleDeclaration =
  | { serve: "static" | "server"; route: string; browser: boolean }
  | { serve: "worker" };

/**
 * A path the gateway routes to the app module this capability vendors into. `mcp: true` turns on
 * the gateway's client sign-in for the app. The CLI copies these into that module in apps.json.
 */
export interface RouteDeclaration {
  path: string;
  mcp?: boolean;
}

/** The managed database this capability asks the platform for. The CLI adds it to apps.json. */
export interface DatabaseDeclaration {
  engine: "postgres";
  extensions?: string[];
}

/**
 * Commands run before the app module this capability vendors into starts. The CLI appends each
 * phase's commands to the same phase of that module in apps.json.
 */
export interface PreStartDeclaration {
  dev?: string[];
  deploy?: string[];
}

/**
 * A strict derived-activation rule. When every referenced capability is
 * effective, the declaring capability activates (a pure conjunction). Its
 * presence makes a capability DERIVED: it is never an ordinary dependency
 * target, and its prerequisites are entered by activation or direct shorthand
 * selection rather than by a dependency edge.
 */
export interface ActivationRule {
  /**
   * The conjunction of capability SOURCE references (bare `id`, `kind/id`, or
   * `registry/kind/id`) that must all be effective. Non-empty and unique;
   * `build-registry` qualifies, validates, and sorts them into the descriptor.
   */
  allOf: string[];
}

/**
 * A parsed `capability.json`. `build-registry` projects these keys into the
 * descriptor, so every descriptor field is a property here; `build-docs` and the
 * registry tests read the subset each one needs. `kind` and the discovered
 * `path` are both REQUIRED: every root is kind-qualified and located at
 * `<kind>/<id>`.
 */
export interface CapabilityManifest {
  id: string;
  version: string;
  /**
   * The single registry-declared selection kind this capability belongs to. In
   * descriptor v3 `kind` is a pure selection group (defined in
   * `registry.config.json`) and no longer implies any runtime behaviour.
   */
  kind: string;
  /**
   * The capability root's location relative to `capabilities/`, always
   * `<kind>/<id>`. DISCOVERED by the scan from the directory tree — never
   * authored in `capability.json`.
   */
  path: string;
  title?: string;
  description?: string;
  categories?: string[];
  default?: boolean;
  /**
   * Picker/discovery visibility. Defaults to true when absent and is omitted
   * from the descriptor when true; author `false` to hide the capability from
   * discovery and pickers. A hidden capability stays directly selectable by
   * identity and observable in installed state, status, and plans.
   */
  visible?: boolean;
  required?: boolean;
  dependencies?: string[];
  /**
   * Strict derived-activation rule; absent means an ordinary capability. When
   * present, this capability activates once every referenced capability is
   * effective, and direct selection installs those references as prerequisites.
   */
  activatedWhen?: ActivationRule;
  packages?: string[];
  pyIndexPackages?: string[];
  docs?: string;
  envVars?: Record<string, string>;
  /**
   * Explicit runtime module the capability produces. Absent means the capability
   * creates no app module. `static`/`server` carry an absolute normalized route
   * prefix and explicit browser ownership; `worker` carries neither.
   */
  module?: ModuleDeclaration;
  /**
   * Extra paths routed to the module this capability vendors into. Read by the CLI off the
   * installed `capability.json` and never written to the descriptor.
   */
  routes?: RouteDeclaration[];
  /** Read by the CLI off the installed `capability.json` and never written to the descriptor. */
  database?: DatabaseDeclaration;
  /** Read by the CLI off the installed `capability.json` and never written to the descriptor. */
  preStart?: PreStartDeclaration;
  /** Sparse compatibility allowlist keyed by kind id (source references). */
  compatibility?: Record<string, string[]>;
  metadata?: CapabilityMetadata;
}

/**
 * Directories that never hold a capability root, at any depth. Only the vendored
 * (`node_modules`) and version-control/tool caches (`.git`, `.venv`) are pruned —
 * matching the CLI. Anything else is walked so a misplaced root cannot hide.
 */
const SKIP_DIRS = {
  node_modules: true,
  ".git": true,
  ".venv": true,
} satisfies Record<string, true>;

/** The shared package tier, a sibling of the capability roots (never a capability). */
const SHARED_PACKAGES_DIR = "packages";

/**
 * Collect every capability root at or below `dir` into `out`, as roots-dir-relative
 * paths. `rel` is the roots-dir-relative prefix of `dir` (empty at the top). A
 * directory holding a `capability.json` IS a root — including `dir` itself (a
 * depth-zero root at the capabilities dir) — and is never descended into; any
 * other directory is a grouping dir and is walked, skipping the vendored/cache
 * dirs and, at the top level only, the shared package tier when it is a sibling
 * (a `.` prefix), so `packages/*` stays outside capability discovery like the CLI.
 */
function scanRoots(dir: string, rel: string, out: string[], sharedTier: string | undefined): void {
  if (existsSync(join(dir, "capability.json"))) {
    out.push(rel);
    return;
  }
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || Object.hasOwn(SKIP_DIRS, dirent.name)) continue;
    if (rel === "" && dirent.name === sharedTier) continue;
    const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
    scanRoots(join(dir, dirent.name), childRel, out, sharedTier);
  }
}

/**
 * Reject a `capabilitiesDir` that would scan outside the repository before any
 * directory read happens. A repo-relative prefix is required: `.` (the repo root)
 * and any contained subpath are allowed, while an absolute path or one that
 * escapes the root (`..`) is refused, so discovery can never read a tree the
 * repo does not own.
 */
function assertContainedDir(repoRoot: string, capabilitiesDir: string): void {
  if (isAbsolute(capabilitiesDir)) {
    throw new Error(
      `capabilitiesDir \`${capabilitiesDir}\` must be a repo-relative path, not absolute.`,
    );
  }
  const rel = relative(repoRoot, join(repoRoot, capabilitiesDir));
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`capabilitiesDir \`${capabilitiesDir}\` escapes the repository root.`);
  }
}

/**
 * Every capability-root location discovered under `capabilitiesDir`, sorted for a
 * stable base ordering. The shared `packages/*` tier is excluded when the prefix
 * is the repo root (`.`). Locations are not yet depth-validated — {@link
 * readManifests} is the one place that validates topology and manifest agreement.
 */
function discoverRootPaths(repoRoot: string, capabilitiesDir: string): string[] {
  assertContainedDir(repoRoot, capabilitiesDir);
  const rootsDir = join(repoRoot, capabilitiesDir);
  const paths: string[] = [];
  const sharedTier = capabilitiesDir === "." ? SHARED_PACKAGES_DIR : undefined;
  if (existsSync(rootsDir)) scanRoots(rootsDir, "", paths, sharedTier);
  return paths.toSorted();
}

/**
 * A discovered capability root at `capabilities/<kind>/<id>`: its `kind`, its
 * bare `id`, and the roots-dir-relative `path` (`<kind>/<id>`) where it lives.
 */
export interface CapabilityRoot {
  id: string;
  kind: string;
  path: string;
}

/**
 * Read and validate every capability manifest, in discovered-path order — the ONE
 * canonical discovery every reader (and {@link readCapabilityRoots}) goes through,
 * so no consumer can see an unvalidated or mis-located root. Every root must sit
 * at exactly `<kind>/<id>` (depth two; a shallow, over-nested, mis-grouped, or
 * depth-zero root is a topology error), its `path` is DISCOVERED (a manifest that
 * authors a `path` key is rejected), and the manifest's `kind`/`id` must agree
 * with its directory. A missing capabilities tier yields an empty list.
 */
export function readManifests(
  repoRoot: string,
  capabilitiesDir = "capabilities",
): CapabilityManifest[] {
  const dir = join(repoRoot, capabilitiesDir);
  return discoverRootPaths(repoRoot, capabilitiesDir).map((path) => {
    const segments = path.split("/");
    if (segments.length !== 2 || segments.some((segment) => segment === "")) {
      throw new Error(
        `capability root \`${capabilitiesDir}/${path}\` must live at exactly \`<kind>/<id>\` (depth two); ` +
          `a shallow, over-nested, mis-grouped, or top-level root is not allowed.`,
      );
    }
    const [kind, id] = segments;
    // SAFETY: capability.json is a repo-owned manifest; `path` is discovered (never
    // authored), so it is parsed as an authored manifest and the checks below fail on drift.
    const authored = JSON.parse(readFileSync(join(dir, path, "capability.json"), "utf8")) as Omit<
      CapabilityManifest,
      "path"
    >;
    if (Object.hasOwn(authored, "path")) {
      throw new Error(
        `capability root \`${capabilitiesDir}/${path}\` authors a \`path\` key; \`path\` is discovered from the directory tree, not written in capability.json.`,
      );
    }
    if (authored.id !== id) {
      throw new Error(
        `capability root \`${capabilitiesDir}/${path}\` holds a manifest whose id is \`${authored.id}\`; the id must equal the root directory's last segment \`${id}\`.`,
      );
    }
    if (authored.kind !== kind) {
      throw new Error(
        `capability root \`${capabilitiesDir}/${path}\` holds a manifest whose kind is \`${authored.kind ?? "missing"}\`; the kind must equal the root's parent directory \`${kind}\`.`,
      );
    }
    return { ...authored, path };
  });
}

/**
 * Every discovered capability root, projected to its identity. A thin projection
 * of {@link readManifests}, so it inherits the same topology and manifest-agreement
 * validation rather than re-scanning — a release-time consumer never sees a root
 * the descriptor builder would reject.
 */
export function readCapabilityRoots(
  repoRoot: string,
  capabilitiesDir = "capabilities",
): CapabilityRoot[] {
  return readManifests(repoRoot, capabilitiesDir).map(({ id, kind, path }) => ({ id, kind, path }));
}

/** `metadata.registryPins`: the template files a carrier projects per index, at least one. */
const REGISTRY_PINS_SCHEMA = z.array(z.string().min(1)).min(1);

/**
 * Resolve every capability whose generated template carries registry connection state. Absence is
 * a release error rather than a guess based on a capability name: core's uv index needs a carrier.
 */
export function registryPinCarriers(
  manifests: readonly CapabilityManifest[],
): CapabilityManifest[] {
  const carriers = manifests.filter(({ metadata }) => metadata?.registryPins !== undefined);
  for (const { path, metadata } of carriers) {
    if (!REGISTRY_PINS_SCHEMA.safeParse(metadata?.registryPins).success) {
      throw new Error(
        `${path}: metadata.registryPins must be a non-empty list of the template files it projects`,
      );
    }
  }
  if (carriers.length === 0) {
    throw new Error("no capability declares `metadata.registryPins`");
  }
  return carriers;
}
