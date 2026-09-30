#!/usr/bin/env bun
/**
 * publication-check.ts — enforce public capability eligibility.
 *
 * A capability opts into public publication only when `manifest.metadata?.public === true`; an
 * absent flag is therefore
 * false for consumers, while this first-party repository requires every
 * manifest to author an explicit boolean. Every capability dependency reachable
 * from a public root must also be public. A public capability must also declare
 * at least one package language: a capability without package languages is
 * git-delivered only, and the source repository is deliberately private. Public npm packages and
 * bun catalogs may name only vendored dependencies or an explicit registry.npmjs.org allowlist.
 * Public Python packages may declare only the typed public registry's `pypi` endpoint and may bind
 * sources only to it. A public template may gate only on public capabilities: a `(has "...")` gate
 * ships verbatim in the published template, so the name it carries becomes public too.
 *
 * `metadata` remains registry-internal rather than becoming a top-level
 * capability authoring key. That leaves the CLI descriptor contract unchanged
 * (the CLI rejects unknown descriptor fields), and the descriptor projection
 * drops the entire metadata block.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { PUBLIC_MISTRAL_NPM_EXEMPTIONS } from "./public-mistral-npm";
import {
  localCapabilityId,
  resolveCapabilityRef,
  uniqueCapabilityId,
} from "../shared/capability-identity";
import { type CapabilityManifest, readManifests } from "../shared/manifests";
import { PACKAGE_REGISTRIES, PUBLIC_PACKAGE_REGISTRY } from "../release/package-registries";

export type PublicationFindingCode =
  | "invalid-public-flag"
  | "private-dependency"
  | "private-npm-dependency"
  | "private-python-index"
  | "private-template-gate"
  | "template-only-public"
  | "unknown-dependency";

export interface PublicationFinding {
  code: PublicationFindingCode;
  capabilityId: string;
  message: string;
}

export interface PublicationResult {
  publicCapabilityIds: string[];
  findings: PublicationFinding[];
}

interface DependencyDeclaration {
  declarers: string[];
  resolutionError?: string;
}

type ReachableCapability =
  | { kind: "manifest"; manifest: CapabilityManifest }
  | { declaration: DependencyDeclaration; kind: "unknown" };

const declarerNoun = ({ declarers }: DependencyDeclaration): string =>
  `${declarers.length === 1 ? "capability" : "capabilities"} ${declarers.map((value) => `"${value}"`).join(", ")}`;

const manifestLocation = (capability: CapabilityManifest, capabilitiesDir: string): string =>
  join(capabilitiesDir, capability.path, "capability.json");

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const nonEmptyString = z.string().refine((value) => value.trim() !== "");
const publicationConfigSchema = z.object({
  id: nonEmptyString,
  capabilitiesDir: nonEmptyString.optional(),
});
const scalarIndexValueSchema = z.union([z.string(), z.array(z.string())]);
const pipScalarIndexSchema = z
  .object({
    "index-url": z.string().optional(),
    "extra-index-url": scalarIndexValueSchema.optional(),
    "find-links": scalarIndexValueSchema.optional(),
  })
  .passthrough();
const npmDependencyMapSchema = z.record(z.string(), z.string()).optional();
const npmPackageSchema = z.looseObject({
  dependencies: npmDependencyMapSchema,
  devDependencies: npmDependencyMapSchema,
  optionalDependencies: npmDependencyMapSchema,
  peerDependencies: npmDependencyMapSchema,
  workspaces: z
    .looseObject({
      catalog: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/**
 * Specifier shapes that resolve from the public registry: a semver range, `*`, `latest`, or a
 * catalog reference whose own entry is checked through the `workspaces.catalog` section. The
 * allowlist reviews a name, not where a given manifest points it, so a `git+ssh://`, `https://`
 * tarball or `npm:` alias under an allowlisted name would otherwise pass the gate unread.
 */
const PUBLIC_NPM_SPECIFIER = /^(?:catalog:|\*$|latest$|[~^><=\d])/;

/**
 * Names reviewed as anonymously resolvable from registry.npmjs.org. Keep this explicit: adding a
 * package is a publication-policy decision, not something the release build may infer from a
 * developer's cache or authenticated npm configuration.
 */
export const PUBLIC_NPM_PACKAGE_ALLOWLIST = new Set([
  "@oxlint/plugins",
  "@shadcn/lint",
  "@types/bun",
  "@types/react",
  "@types/react-dom",
  "class-variance-authority",
  "clsx",
  "dotenv",
  "framer-motion",
  "lucide-react",
  "next-themes",
  "nx",
  "oxfmt",
  "oxlint",
  "oxlint-tsgolint",
  "react",
  "react-dom",
  "sonner",
  "tailwind-merge",
  "tailwind-variants",
  "tailwindcss",
  "turbo",
  "tw-animate-css",
  "typescript",
  "usehooks-ts",
  "zod",
  ...PUBLIC_MISTRAL_NPM_EXEMPTIONS,
]);

const pythonSourceSchema = z.looseObject({ index: z.string().optional() });

const pythonIndexConfigSchema = z.object({
  tool: z
    .object({
      uv: z
        .object({
          "index-url": z.string().optional(),
          "extra-index-url": scalarIndexValueSchema.optional(),
          "find-links": scalarIndexValueSchema.optional(),
          index: z.array(z.object({ name: z.string(), url: z.string() }).passthrough()).optional(),
          pip: pipScalarIndexSchema.optional(),
          sources: z.record(z.string(), pythonSourceSchema).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

const publicPythonIndex = new URL(PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY].py);

function isPublicPythonIndex(name: string, url: string): boolean {
  if (name !== "pypi") return false;
  try {
    const candidate = new URL(url);
    return (
      candidate.protocol === publicPythonIndex.protocol &&
      candidate.host === publicPythonIndex.host &&
      candidate.pathname.replace(/\/+$/, "") === publicPythonIndex.pathname.replace(/\/+$/, "") &&
      // `https://user:secret@pypi.org/simple` matches on protocol, host and path alone, so the
      // endpoint check has to reject the userinfo that would ship in the published pyproject.
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.search === "" &&
      candidate.hash === ""
    );
  } catch {
    return false;
  }
}

/** Selectors narrow when a source applies; they cannot point uv at a different endpoint. */
const PYTHON_SOURCE_SELECTORS = new Set(["marker", "extra", "group"]);

/**
 * A `[tool.uv.sources]` entry may name only the reviewed public index or the local workspace. Any
 * other shape (`url`, `git`, `path`, a second index) points uv at an endpoint this gate has not
 * reviewed, so an absent `index` key is not on its own evidence that the entry is safe. Selectors
 * are dropped before counting, leaving exactly the key that decides where uv resolves from.
 */
function isUnreviewedPythonSource(source: z.infer<typeof pythonSourceSchema>): boolean {
  const kinds = Object.keys(source).filter((key) => !PYTHON_SOURCE_SELECTORS.has(key));
  if (kinds.length !== 1) return true;
  return kinds[0] === "workspace" ? source.workspace !== true : source.index !== "pypi";
}

function scalarIndexValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".turbo") return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function packageJsonFiles(root: string): string[] {
  return walkFiles(root).filter(
    (path) => basename(path) === "package.json" || basename(path) === "package.json.hbs",
  );
}

/**
 * Any `has` call, so a shape this gate cannot read is reported rather than skipped. Handlebars
 * allows whitespace anywhere inside a subexpression, so `( has "x" )` is the same gate as
 * `(has "x")` and has to match here too.
 */
const TEMPLATE_GATE = /\(\s*has\b[^)]*\)/g;
const QUOTED_TEMPLATE_GATE = /^\(\s*has\s+"([^"]+)"\s*\)$/;

/**
 * Capability gates in a public capability's template. Handlebars is not rendered at publication
 * time, so each `(has "<id>")` reaches the published tarball with the capability it names. A gate
 * on a private capability therefore publishes that capability's id.
 *
 * Only `.hbs` files are read, because the CLI copies everything else across untouched. Helm charts
 * and shell scripts in a template are free to spell `(has ...)` for their own reasons.
 */
function templateGateProblems(
  capabilityRoot: string,
  registryId: string,
  manifests: readonly CapabilityManifest[],
  byId: ReadonlyMap<string, CapabilityManifest>,
): string[] {
  const problems: string[] = [];
  for (const path of walkFiles(join(capabilityRoot, "template")).filter((candidate) =>
    candidate.endsWith(".hbs"),
  )) {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      problems.push(
        `${path} cannot be checked for template gates: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const match of source.matchAll(TEMPLATE_GATE)) {
      const line = source.slice(0, match.index).split("\n").length;
      const location = `${path}:${line}`;
      const ref = QUOTED_TEMPLATE_GATE.exec(match[0])?.[1];
      if (ref === undefined) {
        problems.push(`${location} uses the unreadable gate expression \`${match[0]}\``);
        continue;
      }
      let resolved: string;
      try {
        resolved = resolveCapabilityRef(ref, registryId, manifests);
      } catch (error) {
        problems.push(
          `${location} gates on \`${ref}\`, which cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const gated = byId.get(resolved);
      if (gated === undefined) {
        problems.push(`${location} gates on \`${ref}\`, which belongs to another registry`);
      } else if (gated.metadata?.public !== true) {
        problems.push(
          `${location} gates on \`${ref}\`, which is the private capability ${localCapabilityId(gated)}`,
        );
      }
    }
  }
  return problems;
}

/** Render the package-manifest Handlebars subset with every capability gate enabled. */
function renderAllPackageGates(source: string): string {
  const rendered = source
    .replaceAll(/\{\{#if\s+\(\s*has\s+"[^"]+"\s*\)\s*\}\}/g, "")
    .replaceAll(/\{\{\s*\/if\s*\}\}/g, "");
  if (rendered.includes("{{")) {
    throw new Error("unsupported Handlebars expression in package manifest");
  }
  return rendered;
}

function npmPublicationProblems(capabilityRoot: string): string[] {
  const problems: string[] = [];
  const packagePaths = packageJsonFiles(capabilityRoot);
  for (const packagePath of packagePaths) {
    let raw: unknown;
    try {
      raw = JSON.parse(
        packagePath.endsWith(".hbs")
          ? renderAllPackageGates(readFileSync(packagePath, "utf8"))
          : readFileSync(packagePath, "utf8"),
      );
    } catch (error) {
      problems.push(
        `${packagePath} cannot be checked for public npm safety: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const parsed = npmPackageSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${packagePath} has an invalid npm dependency/catalog shape`);
      continue;
    }
    const sections = [
      ["dependencies", parsed.data.dependencies],
      ["devDependencies", parsed.data.devDependencies],
      ["optionalDependencies", parsed.data.optionalDependencies],
      ["peerDependencies", parsed.data.peerDependencies],
      ["workspaces.catalog", parsed.data.workspaces?.catalog],
    ] as const;
    for (const [section, entries] of sections) {
      for (const [name, specifier] of Object.entries(entries ?? {})) {
        if (
          specifier.startsWith("workspace:") ||
          specifier.startsWith("file:") ||
          (PUBLIC_NPM_PACKAGE_ALLOWLIST.has(name) && PUBLIC_NPM_SPECIFIER.test(specifier))
        )
          continue;
        problems.push(`${packagePath} ${section} declares ${name}@${specifier}`);
      }
    }
  }
  return problems;
}

/** Read and validate the config fields consumed by this hard gate. */
function readPublicationConfig(repoRoot: string): z.infer<typeof publicationConfigSchema> {
  const configPath = join(repoRoot, "registry.config.json");
  const config = publicationConfigSchema.safeParse(JSON.parse(readFileSync(configPath, "utf8")));
  if (!config.success) {
    const invalidId = config.error.issues.some(({ path }) => path.length === 0 || path[0] === "id");
    if (invalidId) {
      throw new Error(`${configPath} must declare \`id\` as a non-empty string.`);
    }
    throw new Error(
      `${configPath} must declare \`capabilitiesDir\` as a non-empty string when present.`,
    );
  }
  return config.data;
}

/**
 * Enforce the repository's explicit visibility policy and the transitive public
 * dependency invariant. Missing `metadata.public` is false to a consumer, but a
 * hard authoring error in this first-party repository.
 */
export function checkPublicationGraph(
  manifests: readonly CapabilityManifest[],
  registryId: string,
  capabilitiesDir: string,
  repoRoot?: string,
): PublicationResult {
  const byId = new Map(
    manifests.map((manifest) => [uniqueCapabilityId(registryId, manifest), manifest]),
  );
  const findings: PublicationFinding[] = [];

  for (const manifest of manifests) {
    if (!isBoolean(manifest.metadata?.public)) {
      findings.push({
        code: "invalid-public-flag",
        capabilityId: localCapabilityId(manifest),
        message: `${manifestLocation(manifest, capabilitiesDir)} must explicitly declare metadata.public as a boolean (an absent value is consumer-false, but invalid for first-party authoring).`,
      });
    }
  }

  const publicCapabilities = manifests.filter((manifest) => manifest.metadata?.public === true);
  const publicCapabilityIds = publicCapabilities
    .map((manifest) => localCapabilityId(manifest))
    .toSorted((a, b) => a.localeCompare(b));

  for (const manifest of publicCapabilities) {
    if ((manifest.packages?.length ?? 0) === 0) {
      findings.push({
        code: "template-only-public",
        capabilityId: localCapabilityId(manifest),
        message: `public capability "${localCapabilityId(manifest)}" declares no package languages and is template-only; external consumers cannot install it without sources.git, which points at the private source repository (${manifestLocation(manifest, capabilitiesDir)}).`,
      });
    }

    if (repoRoot === undefined) continue;

    const capabilityRoot = join(repoRoot, capabilitiesDir, manifest.path);
    const gateProblems = templateGateProblems(capabilityRoot, registryId, manifests, byId);
    if (gateProblems.length > 0) {
      findings.push({
        code: "private-template-gate",
        capabilityId: localCapabilityId(manifest),
        message:
          `${capabilityRoot} is public but its template carries capability gates that are not public:\n` +
          gateProblems.map((problem) => `  - ${problem}`).join("\n") +
          "; a gate is published unrendered, so it may name only a public capability of this registry.",
      });
    }

    if (manifest.packages?.includes("ts")) {
      const npmProblems = npmPublicationProblems(capabilityRoot);
      if (npmProblems.length > 0) {
        findings.push({
          code: "private-npm-dependency",
          capabilityId: localCapabilityId(manifest),
          message:
            `${capabilityRoot} is public but contains npm package or bun catalog entries that are not proved resolvable on registry.npmjs.org:\n` +
            npmProblems.map((problem) => `  - ${problem}`).join("\n") +
            "; use a workspace:/file: vendored dependency or add a reviewed public package name to PUBLIC_NPM_PACKAGE_ALLOWLIST.",
        });
      }
    }

    if (!manifest.packages?.includes("py")) continue;
    const pyprojectPath = join(
      repoRoot,
      capabilitiesDir,
      manifest.path,
      "package",
      "py",
      "pyproject.toml",
    );
    if (!existsSync(pyprojectPath)) continue; // Package-layout validation owns the missing-file error.

    let rawConfig: unknown;
    try {
      rawConfig = Bun.TOML.parse(readFileSync(pyprojectPath, "utf8"));
    } catch (error) {
      findings.push({
        code: "private-python-index",
        capabilityId: localCapabilityId(manifest),
        message: `${pyprojectPath} cannot be checked for public Python index safety because it is invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const config = pythonIndexConfigSchema.safeParse(rawConfig);
    if (!config.success) {
      findings.push({
        code: "private-python-index",
        capabilityId: localCapabilityId(manifest),
        message: `${pyprojectPath} has an invalid [tool.uv] index/source shape and cannot be proved safe for public publication: ${config.error.message}`,
      });
      continue;
    }
    const privateIndexNames = (config.data.tool?.uv?.index ?? []).flatMap(({ name, url }) =>
      isPublicPythonIndex(name, url) ? [] : [name],
    );
    const privateBindings = Object.entries(config.data.tool?.uv?.sources ?? {}).flatMap(
      ([name, source]) => (isUnreviewedPythonSource(source) ? [name] : []),
    );
    const uv = config.data.tool?.uv;
    const scalarSettings = [
      ["tool.uv.index-url", uv?.["index-url"] === undefined ? [] : [uv["index-url"]]],
      ["tool.uv.extra-index-url", scalarIndexValues(uv?.["extra-index-url"])],
      ["tool.uv.find-links", scalarIndexValues(uv?.["find-links"])],
      ["tool.uv.pip.index-url", uv?.pip?.["index-url"] === undefined ? [] : [uv.pip["index-url"]]],
      ["tool.uv.pip.extra-index-url", scalarIndexValues(uv?.pip?.["extra-index-url"])],
      ["tool.uv.pip.find-links", scalarIndexValues(uv?.pip?.["find-links"])],
    ] as const;
    const privateScalarSettings = scalarSettings.flatMap(([setting, values]) =>
      values.flatMap((value) =>
        isPublicPythonIndex("pypi", value) ? [] : [`${setting}=${JSON.stringify(value)}`],
      ),
    );
    if (
      privateIndexNames.length === 0 &&
      privateBindings.length === 0 &&
      privateScalarSettings.length === 0
    )
      continue;

    findings.push({
      code: "private-python-index",
      capabilityId: localCapabilityId(manifest),
      message:
        `${pyprojectPath} is public but declares private Python index configuration` +
        `${privateIndexNames.length > 0 ? ` (index: ${privateIndexNames.join(", ")})` : ""}` +
        `${privateBindings.length > 0 ? ` (source bindings: ${privateBindings.join(", ")})` : ""}` +
        `${privateScalarSettings.length > 0 ? ` (scalar settings: ${privateScalarSettings.join(", ")})` : ""}; public packages may bind only to the normal \`pypi\` index.`,
    });
  }

  const dependencyDeclarations = new Map<string, DependencyDeclaration>();
  const reachable = new Map<string, ReachableCapability>(
    publicCapabilities.map((manifest) => [
      uniqueCapabilityId(registryId, manifest),
      { kind: "manifest", manifest },
    ]),
  );
  const queue = [...publicCapabilities];
  for (let manifest = queue.pop(); manifest !== undefined; manifest = queue.pop()) {
    for (const dependencyRef of manifest.dependencies ?? []) {
      let normalizedRef = dependencyRef;
      let resolutionError: string | undefined;
      try {
        normalizedRef = resolveCapabilityRef(dependencyRef, registryId, manifests);
      } catch (error) {
        resolutionError = error instanceof Error ? error.message : String(error);
      }

      const declaredBy = localCapabilityId(manifest);
      let declaration = dependencyDeclarations.get(normalizedRef);
      if (declaration === undefined) {
        declaration = { declarers: [declaredBy], resolutionError };
        dependencyDeclarations.set(normalizedRef, declaration);
      } else if (!declaration.declarers.includes(declaredBy)) {
        declaration.declarers.push(declaredBy);
        declaration.declarers.sort((a, b) => a.localeCompare(b));
      }

      if (resolutionError !== undefined || reachable.has(normalizedRef)) continue;
      const dependency = byId.get(normalizedRef);
      if (dependency === undefined) {
        reachable.set(normalizedRef, { declaration, kind: "unknown" });
      } else {
        reachable.set(normalizedRef, { kind: "manifest", manifest: dependency });
        queue.push(dependency);
      }
    }
  }

  for (const [dependencyRef, declaration] of [...dependencyDeclarations].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (declaration.resolutionError === undefined) continue;
    const subject = declarerNoun(declaration);
    findings.push({
      code: "unknown-dependency",
      capabilityId: dependencyRef,
      message: `${subject} ${declaration.declarers.length === 1 ? "declares" : "declare"} capability reference "${dependencyRef}", which is reachable from a public capability but cannot be resolved: ${declaration.resolutionError}`,
    });
  }
  for (const [id, dependency] of [...reachable].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (dependency.kind === "unknown") {
      findings.push({
        code: "unknown-dependency",
        capabilityId: id,
        message: `capability "${id}" is reachable from a public capability but has no capability manifest; the dependency is declared by ${declarerNoun(dependency.declaration)}.`,
      });
    } else if (dependency.manifest.metadata?.public !== true) {
      findings.push({
        code: "private-dependency",
        capabilityId: localCapabilityId(dependency.manifest),
        message: `${manifestLocation(dependency.manifest, capabilitiesDir)} is reachable from a public capability but is not public; set metadata.public to true or remove the dependency from the public closure.`,
      });
    }
  }

  return { publicCapabilityIds, findings };
}

/**
 * Return the only capability set release builders may route publicly. The same
 * graph validation used by the standalone hard gate runs in-process, so a
 * skipped or reordered CI job cannot make an invalid public manifest publishable.
 */
export function validatedPublicCapabilities(
  manifests: readonly CapabilityManifest[],
  registryId: string,
  capabilitiesDir: string,
  repoRoot?: string,
): CapabilityManifest[] {
  const result = checkPublicationGraph(manifests, registryId, capabilitiesDir, repoRoot);
  if (result.findings.length > 0) {
    throw new Error(
      `public capability eligibility failed:\n${result.findings.map(({ message }) => `- ${message}`).join("\n")}`,
    );
  }
  const publicIds = new Set(result.publicCapabilityIds);
  return manifests.filter((manifest) => publicIds.has(localCapabilityId(manifest)));
}

/** Convert publication findings into the checker process exit status. */
export const publicationExitCode = (result: PublicationResult): number =>
  result.findings.length === 0 ? 0 : 1;

const printPublicationReport = (result: PublicationResult): void => {
  const lines = [
    "PUBLIC CAPABILITY ELIGIBILITY (HARD GATE)",
    `Public capabilities: ${result.publicCapabilityIds.length === 0 ? "(none)" : result.publicCapabilityIds.join(", ")}`,
  ];
  if (result.findings.length === 0) {
    lines.push("PASS — explicit publication metadata and public dependency closure are valid.");
    console.log(lines.join("\n"));
    return;
  }

  lines.push(`FAIL — ${result.findings.length} hard finding(s):`);
  for (const finding of result.findings) lines.push(`- [${finding.code}] ${finding.message}`);
  console.error(lines.join("\n"));
};

function main(): void {
  const repoRoot = process.cwd();
  const config = readPublicationConfig(repoRoot);
  const capabilitiesDir = config.capabilitiesDir ?? "capabilities";
  const manifests = readManifests(repoRoot, capabilitiesDir);
  const result = checkPublicationGraph(manifests, config.id, capabilitiesDir, repoRoot);
  printPublicationReport(result);
  process.exitCode = publicationExitCode(result);
}

if (import.meta.main) main();
