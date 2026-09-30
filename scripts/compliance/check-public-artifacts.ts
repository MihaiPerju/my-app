#!/usr/bin/env bun
/**
 * Builds the publication artifacts and checks their archive contents for private
 * infrastructure references. This deliberately scans packed files rather than
 * the source tree so package inclusion rules are part of the assertion.
 *
 *   bun run public-artifacts:check              # build a candidate set, then scan it
 *   bun run public-artifacts:check --prebuilt   # scan the dist/ already in this checkout
 *
 * The real release preparation scripts rewrite tracked manifests. The default mode therefore runs
 * the canonical prepare-and-build sequence in a temporary checkout, scans its `dist/` in place,
 * then removes it. That answers whether this commit *can* produce a clean public set, which is what
 * a pull request needs to know. `--prebuilt` answers the different question the release needs:
 * whether the artifact the publish jobs are about to upload is clean.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { validatedPublicCapabilities } from "../registry/publication-check";
import { buildArtifacts } from "../release/build-artifacts";
import { REGISTRY_ID } from "../release/package-manifests";
import { PACKAGE_REGISTRIES, PUBLIC_PACKAGE_REGISTRY } from "../release/package-registries";
import { planFor, readPlan, type PlanEntry } from "../release/publish-plan";
import {
  localCapabilityId,
  normalizePyDistName,
  npmCapabilityName,
  pyDistNameFromArtifact,
} from "../shared/capability-identity";
import { type JsonValue, readManifests } from "../shared/manifests";
import { scanArtifact, sha256, type ArchiveMember, type Finding } from "./archive-scanner";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface PublicCapability {
  id: string;
  kind: string;
  packages: string[];
  path: string;
}

interface SelectedNpmArtifact {
  name: string;
  path: string;
}

interface ArtifactSelection {
  npm: SelectedNpmArtifact[];
  publicCapabilities: PublicCapability[];
  python: string[];
}

const packedCapabilitySchema = z
  .object({
    activatedWhen: z
      .object({ allOf: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    compatibility: z.record(z.string(), z.array(z.string())).optional(),
    dependencies: z.array(z.string()).optional(),
    id: z.string(),
    kind: z.string(),
    metadata: z.object({ public: z.unknown().optional() }).passthrough().optional(),
    packages: z.array(z.string()).optional(),
    version: z.string().optional(),
  })
  .passthrough();

type PackedCapability = z.infer<typeof packedCapabilitySchema>;

const packedDescriptorSchema = z
  .object({
    capabilities: z.array(packedCapabilitySchema),
    kinds: z.array(z.object({ id: z.string() }).passthrough()),
    metadata: z.unknown().optional(),
    sources: z.object({ git: z.string().optional(), py: z.string(), ts: z.string() }).passthrough(),
  })
  .passthrough();

type PackedDescriptor = z.infer<typeof packedDescriptorSchema>;

const DESCRIPTOR_PACKAGE_NAME = "@mistralai-capabilities/registry";

function copyCheckout(destination: string): void {
  const listing = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (listing.exitCode !== 0) {
    throw new Error(
      `could not enumerate checkout: ${listing.stderr.toString("utf8").trim() || `exit ${listing.exitCode}`}`,
    );
  }
  for (const path of listing.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const source = join(root, path);
    if (!existsSync(source)) continue; // A tracked deletion in the working tree is intentionally absent.
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    if (statSync(source).isDirectory()) cpSync(source, target, { recursive: true });
    else copyFileSync(source, target);
  }

  const installedDependencies = join(root, "node_modules");
  if (!existsSync(installedDependencies)) {
    throw new Error("node_modules is missing; run bun install before the public artifact check");
  }
  symlinkSync(installedDependencies, join(destination, "node_modules"), "junction");
}

/** Fail closed when the staged checkout's capability manifest count differs from the source. */
export function assertCapabilityCopyComplete(sourceCount: number, checkout: string): void {
  const checkoutCount = readManifests(checkout).length;
  if (checkoutCount !== sourceCount) {
    throw new Error(
      `staged checkout capability count mismatch: source has ${sourceCount}, staged checkout has ${checkoutCount}`,
    );
  }
}

interface PreparedBuild {
  checkout: string;
  cleanup: () => void;
}

/**
 * Scan a `dist/` that something else produced, against the checkout it was produced from.
 *
 * The release pipeline uses this for the artifact the publish jobs upload. Rebuilding would scan a
 * second set of bytes: the build is not reproducible (the version string differs, and lifecycle
 * scripts and PEP 517 backends run again), so a clean rebuild would say nothing about what is
 * actually published. It also means this mode extracts archives but runs no build.
 */
function prebuiltArtifacts(): PreparedBuild {
  if (!existsSync(join(root, "dist"))) {
    throw new Error("--prebuilt was given but there is no dist directory to scan");
  }
  return { checkout: root, cleanup: () => {} };
}

async function buildPreparedArtifacts(): Promise<PreparedBuild> {
  const sourceManifestCount = readManifests(root).length;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "public-artifact-build-"));
  const checkout = join(temporaryRoot, "checkout");
  try {
    mkdirSync(checkout);
    copyCheckout(checkout);
    assertCapabilityCopyComplete(sourceManifestCount, checkout);
    await buildArtifacts(checkout, "0.0.0");
    if (!existsSync(join(checkout, "dist"))) {
      throw new Error("canonical artifact build produced no dist directory");
    }
    return {
      checkout,
      cleanup: () => rmSync(temporaryRoot, { force: true, recursive: true }),
    };
  } catch (error) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
}

function checkedArtifactPath(entry: PlanEntry, npmOutDir: string): string {
  const artifact = resolve(npmOutDir, entry.tarball);
  const outputPrefix = `${resolve(npmOutDir)}${sep}`;
  if (!artifact.startsWith(outputPrefix)) {
    throw new Error(`publish plan path escapes dist/npm: ${entry.tarball}`);
  }
  if (!existsSync(artifact) || !statSync(artifact).isFile()) {
    throw new Error(`publish plan artifact is missing: ${entry.tarball}`);
  }
  return artifact;
}

function readPublicCapabilities(checkout: string): PublicCapability[] {
  return validatedPublicCapabilities(
    readManifests(checkout),
    REGISTRY_ID,
    "capabilities",
    checkout,
  ).map(({ id, kind, packages, path }) => ({ id, kind, packages: packages ?? [], path }));
}

/**
 * The canonical public plan is the npm audience boundary. The independent name
 * assertion makes the compliance gate fail closed if artifact construction ever
 * routes a private capability (or an unapproved shared package) to that plan.
 */
function selectNpmArtifacts(
  checkout: string,
  publicCapabilities: PublicCapability[],
): SelectedNpmArtifact[] {
  const npmOutDir = join(checkout, "dist", "npm");
  const publicPlan = planFor(
    PUBLIC_PACKAGE_REGISTRY,
    readPlan(join(npmOutDir, "publish-plan.json")),
  );
  const expectedNames = new Set([
    DESCRIPTOR_PACKAGE_NAME,
    ...publicCapabilities
      .filter(({ packages }) => packages.includes("ts"))
      .map((capability) => npmCapabilityName(REGISTRY_ID, capability)),
  ]);
  const unexpected = publicPlan.filter(({ name }) => !expectedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `public npm build included non-public package(s): ${[...new Set(unexpected.map(({ name }) => name))].join(", ")}`,
    );
  }
  for (const name of expectedNames) {
    if (!publicPlan.some((entry) => entry.name === name)) {
      throw new Error(`publish plan has no public artifact for ${name}`);
    }
  }
  return publicPlan.map((entry) => ({
    name: entry.name,
    path: checkedArtifactPath(entry, npmOutDir),
  }));
}

function readTarMember(artifact: string, member: string): string {
  const result = Bun.spawnSync(["tar", "-xzOf", artifact, member], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${relative(process.cwd(), artifact)} is missing ${member}: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.toString("utf8");
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .map(({ message, path }) => `${path.length === 0 ? "<root>" : path.join(".")}: ${message}`)
    .join("; ");
}

function parseArtifactJson<T>(
  artifact: string,
  member: string,
  parseValue: (value: JsonValue) => T,
): T {
  const source = readTarMember(artifact, member);
  let value: JsonValue;
  try {
    // SAFETY: JSON.parse yields plain JSON data; JsonValue is this repository's decoded-JSON
    // domain type and readPacked* validates the exact nested structure before use.
    value = JSON.parse(source) as JsonValue;
  } catch (error) {
    throw new Error(
      `${relative(process.cwd(), artifact)} ${member} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseValue(value);
}

export function readPackedDescriptorFromArtifact(artifact: string): PackedDescriptor {
  return parseArtifactJson(artifact, "package/registry.json", (value) => {
    const descriptor = packedDescriptorSchema.safeParse(value);
    if (!descriptor.success) {
      throw new Error(
        `${relative(process.cwd(), artifact)} package/registry.json has an invalid descriptor shape: ${zodIssues(descriptor.error)}`,
      );
    }
    return descriptor.data;
  });
}

export function readPackedCapabilityFromArtifact(artifact: string): PackedCapability {
  return parseArtifactJson(artifact, "package/capability.json", (value) => {
    const capability = packedCapabilitySchema.safeParse(value);
    if (!capability.success) {
      throw new Error(
        `${relative(process.cwd(), artifact)} package/capability.json has an invalid capability shape: ${zodIssues(capability.error)}`,
      );
    }
    return capability.data;
  });
}

function canonicalEndpoint(url: string): URL {
  const endpoint = new URL(url);
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      `descriptor source endpoint ${JSON.stringify(url)} carries disallowed auth/query/fragment components`,
    );
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  return endpoint;
}

function isExpectedPublicEndpoint(actual: string, expected: string): boolean {
  try {
    const actualEndpoint = canonicalEndpoint(actual);
    const expectedEndpoint = canonicalEndpoint(expected);
    return (
      actualEndpoint.protocol === expectedEndpoint.protocol &&
      actualEndpoint.host === expectedEndpoint.host &&
      actualEndpoint.pathname === expectedEndpoint.pathname
    );
  } catch {
    return false;
  }
}

function publicReferenceSet(publicCapabilities: readonly PublicCapability[]): Set<string> {
  return new Set(
    publicCapabilities.flatMap((capability) => [
      capability.id,
      localCapabilityId(capability),
      `${REGISTRY_ID}/${localCapabilityId(capability)}`,
    ]),
  );
}

function assertReferencesPublic(
  capability: PackedCapability,
  publicRefs: ReadonlySet<string>,
  subject: string,
): void {
  const references = [
    ...(capability.dependencies ?? []),
    ...(capability.activatedWhen?.allOf ?? []),
    ...Object.values(capability.compatibility ?? {}).flat(),
  ];
  const privateReferences = references.filter((reference) => !publicRefs.has(reference));
  if (privateReferences.length > 0) {
    throw new Error(
      `${subject} references capability identities outside the public closure: ${privateReferences.join(", ")}`,
    );
  }
}

/** Independently validate the descriptor bytes packed for the public registry. */
export function assertPublicDescriptorClosure(
  descriptor: PackedDescriptor,
  publicCapabilities: readonly PublicCapability[],
): void {
  if (descriptor.metadata !== undefined) {
    throw new Error("public descriptor contains registry-internal metadata");
  }
  const expected = publicCapabilities.map(localCapabilityId).toSorted();
  const actual = descriptor.capabilities.map(localCapabilityId).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `public descriptor capability set mismatch: expected ${expected}, got ${actual}`,
    );
  }
  const expectedKinds = [...new Set(publicCapabilities.map(({ kind }) => kind))].toSorted();
  const actualKinds = descriptor.kinds.map(({ id }) => id).toSorted();
  if (JSON.stringify(actualKinds) !== JSON.stringify(expectedKinds)) {
    throw new Error(
      `public descriptor kind set mismatch: expected ${expectedKinds}, got ${actualKinds}`,
    );
  }
  const expectedSources = PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY];
  if (
    descriptor.sources.git !== undefined ||
    !isExpectedPublicEndpoint(descriptor.sources.ts, expectedSources.ts) ||
    !isExpectedPublicEndpoint(descriptor.sources.py, expectedSources.py)
  ) {
    throw new Error("public descriptor sources are not the anonymous npm/PyPI endpoints");
  }
  const publicRefs = publicReferenceSet(publicCapabilities);
  for (const capability of descriptor.capabilities) {
    if (capability.metadata !== undefined) {
      throw new Error(
        `public descriptor capability ${localCapabilityId(capability)} contains metadata`,
      );
    }
    const foreignCompatibilityKinds = Object.keys(capability.compatibility ?? {}).filter(
      (kind) => !expectedKinds.includes(kind),
    );
    if (foreignCompatibilityKinds.length > 0) {
      throw new Error(
        `public descriptor capability ${localCapabilityId(capability)} has compatibility keys outside the public kind set: ${foreignCompatibilityKinds.join(", ")}`,
      );
    }
    assertReferencesPublic(
      capability,
      publicRefs,
      `public descriptor capability ${localCapabilityId(capability)}`,
    );
  }
}

/** Validate the manifest packed inside each public capability package. */
export function assertPackedPublicCapabilityClosure(
  capability: PackedCapability,
  publicCapabilities: readonly PublicCapability[],
  expectedPackageName: string,
): void {
  const local = localCapabilityId(capability);
  const expectedIdentity = npmCapabilityName(REGISTRY_ID, capability);
  if (expectedIdentity !== expectedPackageName) {
    throw new Error(
      `packed capability ${local} is routed as ${expectedPackageName}, but its manifest identity is ${expectedIdentity}`,
    );
  }
  if (!publicCapabilities.some((candidate) => localCapabilityId(candidate) === local)) {
    throw new Error(`packed capability ${local} is outside the public manifest set`);
  }
  if (capability.metadata?.public !== true) {
    throw new Error(
      `packed public capability ${local} does not explicitly declare metadata.public=true`,
    );
  }
  assertReferencesPublic(
    capability,
    publicReferenceSet(publicCapabilities),
    `packed capability ${local}`,
  );
}

function pythonDistributionName(
  checkout: string,
  capability: PublicCapability,
): string | undefined {
  if (!capability.packages.includes("py")) return undefined;
  const pyproject = join(
    checkout,
    "capabilities",
    capability.path,
    "package",
    "py",
    "pyproject.toml",
  );
  if (!existsSync(pyproject)) {
    throw new Error(
      `public Python capability ${localCapabilityId(capability)} has no ${relative(checkout, pyproject)}`,
    );
  }
  const source = readFileSync(pyproject, "utf8");
  const projectHeader = /^\s*\[project\]\s*$/m.exec(source);
  if (!projectHeader) throw new Error(`${relative(checkout, pyproject)} has no [project] table`);
  const bodyStart = projectHeader.index + projectHeader[0].length;
  const rest = source.slice(bodyStart);
  const nextTable = /^\s*\[/m.exec(rest);
  const projectBody = rest.slice(0, nextTable?.index);
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(projectBody)?.[1];
  if (!name) throw new Error(`${relative(checkout, pyproject)} has no [project].name`);
  return normalizePyDistName(name);
}

/** Read the normalized distribution component from a wheel or modern sdist path. */
export function pythonArtifactDistributionName(artifact: string): string {
  return pyDistNameFromArtifact(artifact.slice(artifact.lastIndexOf(sep) + 1));
}

/**
 * Verify the builder-owned public directory independently against public manifests before scanning
 * its contents. This catches a selector regression that copies a private but otherwise clean
 * distribution into the exact directory consumed by PyPI.
 */
export function selectPythonArtifacts(
  checkout: string,
  publicCapabilities: PublicCapability[],
): string[] {
  const pythonOutDir = join(checkout, "dist", "py-public");
  if (!existsSync(pythonOutDir)) {
    throw new Error("dist/py-public is missing after the Python build");
  }
  const built = readdirSync(pythonOutDir)
    .filter((name) => name.endsWith(".whl") || name.endsWith(".tar.gz"))
    .map((name) => join(pythonOutDir, name))
    .filter((path) => statSync(path).isFile())
    .toSorted();
  const expectedDistributions = new Map(
    publicCapabilities.flatMap((capability) => {
      const distribution = pythonDistributionName(checkout, capability);
      return distribution === undefined
        ? []
        : [[distribution, localCapabilityId(capability)] as const];
    }),
  );

  const unexpected = built.filter(
    (artifact) => !expectedDistributions.has(pythonArtifactDistributionName(artifact)),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `public Python build included non-public distribution(s): ${unexpected
        .map(pythonArtifactDistributionName)
        .filter((name, index, names) => names.indexOf(name) === index)
        .join(", ")}`,
    );
  }
  for (const [distribution, capabilityId] of expectedDistributions) {
    if (!built.some((artifact) => pythonArtifactDistributionName(artifact) === distribution)) {
      throw new Error(`Python build produced no artifact for public capability ${capabilityId}`);
    }
  }
  return built;
}

/**
 * Every public artifact must carry the licence text. The npm and Python paths both stage it from
 * the repo-root `LICENSE` at prepare time rather than tracking a copy per package, and uv_build
 * skips a `license-files` glob that matches nothing instead of failing, so nothing upstream of here
 * turns a missing copy into a build error.
 *
 * Match on the basename, because each packer puts it somewhere different: npm packs it as
 * `package/LICENSE`, an sdist as `<name>-<version>/LICENSE`, a wheel as
 * `<name>-<version>.dist-info/licenses/LICENSE`. Compare the bytes rather than the name, so that a
 * directory called `LICENSE`, a symlink, or an empty or unrelated file with that name does not
 * satisfy the check.
 */
export function licensedArtifact(members: ArchiveMember[], licenseDigest: string): boolean {
  return members.some(
    ({ digest, name }) =>
      name.slice(name.lastIndexOf("/") + 1) === "LICENSE" && digest === licenseDigest,
  );
}

function selectArtifacts(checkout: string): ArtifactSelection {
  const publicCapabilities = readPublicCapabilities(checkout);
  return {
    npm: selectNpmArtifacts(checkout, publicCapabilities),
    publicCapabilities,
    python: selectPythonArtifacts(checkout, publicCapabilities),
  };
}

async function main(): Promise<void> {
  if (resolve(process.cwd()) !== root) {
    throw new Error(`run this command from the repository root: ${root}`);
  }
  const prebuilt = process.argv.slice(2).includes("--prebuilt");

  console.log(
    prebuilt
      ? "Inspecting the prebuilt dist/ against this checkout..."
      : "Building prepared npm and Python publication artifacts for inspection...",
  );
  const prepared = prebuilt ? prebuiltArtifacts() : await buildPreparedArtifacts();
  try {
    const {
      npm: npmArtifacts,
      publicCapabilities,
      python: pythonArtifacts,
    } = selectArtifacts(prepared.checkout);
    console.log(
      `Public capability set (${publicCapabilities.length}): ${publicCapabilities.map(localCapabilityId).join(", ") || "none"}.`,
    );
    console.log("Scanning the canonical public npm plan and dist/py-public artifact set.");
    const descriptorArtifact = npmArtifacts.find(({ name }) => name === DESCRIPTOR_PACKAGE_NAME);
    if (descriptorArtifact === undefined) throw new Error("public descriptor artifact is missing");
    assertPublicDescriptorClosure(
      readPackedDescriptorFromArtifact(descriptorArtifact.path),
      publicCapabilities,
    );
    for (const artifact of npmArtifacts.filter(({ name }) => name !== descriptorArtifact.name)) {
      assertPackedPublicCapabilityClosure(
        readPackedCapabilityFromArtifact(artifact.path),
        publicCapabilities,
        artifact.name,
      );
    }

    const artifacts = [...npmArtifacts.map(({ path }) => path), ...pythonArtifacts];
    const findings: Finding[] = [];
    const unlicensed: string[] = [];
    const licenseDigest = sha256(readFileSync(join(prepared.checkout, "LICENSE")));
    let scanned = 0;

    for (const artifact of artifacts) {
      const result = await scanArtifact(artifact);
      findings.push(...result.findings);
      scanned += result.scanned;
      if (!licensedArtifact(result.members, licenseDigest)) {
        unlicensed.push(relative(prepared.checkout, artifact));
      }
    }
    if (unlicensed.length > 0) {
      throw new Error(
        `public artifact(s) carry no LICENSE matching the repository's: ${unlicensed.join(", ")}`,
      );
    }

    console.log(
      `Inspected ${npmArtifacts.length} npm artifact(s), ${pythonArtifacts.length} Python artifact(s), and ${scanned} regular archive member(s).`,
    );
    if (findings.length > 0) {
      for (const finding of findings) {
        console.error(
          `FORBIDDEN [${finding.policy}] artifact=${JSON.stringify(finding.artifact)} member=${JSON.stringify(finding.member)} part=${finding.part}`,
        );
      }
      throw new Error(
        `found ${findings.length} forbidden reference(s) in public-candidate artifacts`,
      );
    }

    console.log("PASS: the complete public artifact set was checked.");
  } finally {
    prepared.cleanup();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `Public artifact check failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}
