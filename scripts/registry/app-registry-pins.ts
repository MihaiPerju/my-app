#!/usr/bin/env bun
/**
 * app-registry-pins.ts — write the generated-app registry projection the CLI does not set at init:
 * the private npm scope mapping of the capability that pins `@mistralai/*` / `@mistral/*`
 * packages, core's `@mistralai-capabilities` bun scope, its `mistralai` uv index and source
 * bindings, the Python index username in `tools/uv.sh`, and matching ignore-file behavior. Every capability declaring
 * `metadata.registryPins` is a carrier, and each template file it lists there is projected by
 * that path's projector in `REGISTRY_PINS`. All files derive from the typed registry definition in `package-registries.ts`;
 * `--check` runs via `registry:check` and fails on drift.
 *
 *   bun scripts/registry/app-registry-pins.ts          # write the pins
 *   bun scripts/registry/app-registry-pins.ts --check  # fail if a committed pin is stale
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { PUBLIC_MISTRAL_NPM_EXEMPTIONS } from "./public-mistral-npm";
import { type GeneratedFile, syncGeneratedFiles } from "../shared/generated-files";
import { type CapabilityManifest, readManifests, registryPinCarriers } from "../shared/manifests";
import {
  DEFAULT_PACKAGE_REGISTRY,
  INTERNAL_PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRIES,
  PACKAGE_REGISTRY_LANGUAGES,
  type PackageRegistryId,
} from "../release/package-registries";

/** Registry pins must use TLS; private variants also carry pull credentials. */
function registryUrl(id: PackageRegistryId, url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(
      `app-registry-pins: the ${id} index is ${parsed.protocol}//, but registry pins must use https`,
    );
  }
  return parsed;
}

/** Mistral-scoped npm names are assumed private unless explicitly reviewed for anonymous npm.
 * This does not match our own public `@mistralai-capabilities/*` scope. */
const MISTRAL_NPM_SCOPE = /^@mistral(ai)?\//;
const MISTRAL_NPM_SCOPE_MENTION = /@mistral(ai)?\//g;

function isUnreviewedMistralPackage(name: string): boolean {
  return MISTRAL_NPM_SCOPE.test(name) && !PUBLIC_MISTRAL_NPM_EXEMPTIONS.has(name);
}

/** Inspect free text as well as package keys. An exemption applies to an entire package name,
 * never a prefix such as `@mistralai/mistralai-private` or a subpath. */
function hasUnreviewedMistralMention(text: string): boolean {
  for (const match of text.matchAll(MISTRAL_NPM_SCOPE_MENTION)) {
    const mention = text.slice(match.index);
    const exempt = [...PUBLIC_MISTRAL_NPM_EXEMPTIONS].some(
      (name) =>
        mention.startsWith(name) &&
        mention[name.length] !== "/" &&
        mention[name.length] !== "%" &&
        !/[a-zA-Z0-9._~-]/.test(mention[name.length] ?? ""),
    );
    if (!exempt) return true;
  }
  return false;
}

/** Replace an audience-specific regex anchor, failing instead of silently retaining it. */
function replaceRequired(
  current: string,
  anchor: RegExp,
  replacement: string,
  description: string,
): string {
  if (!new RegExp(anchor.source, anchor.flags.replace("g", "")).test(current)) {
    throw new Error(`app-registry-pins: could not find ${description}`);
  }
  return current.replace(anchor, replacement);
}

/**
 * The app's `.npmrc`, shipped by the capability whose template pins private `@mistralai/*` /
 * `@mistral/*` packages. npm strips that literal name from package tarballs, so `.npmrc.hbs` is
 * the required carrier; the CLI renders it to `.npmrc` without changing its static content, but
 * only after its first `bun install`. The host-keyed token line also authenticates the
 * `@mistralai-capabilities` scope the CLI maps to the same index in `bunfig.toml`.
 */
export function buildNpmrc(id: PackageRegistryId): string {
  const registry = PACKAGE_REGISTRIES[id];
  const { host } = registryUrl(id, registry.ts);
  // OPERATIONAL PRECONDITION: before any capability with a live @mistralai/* or @mistral/*
  // dependency is made public, Mistral must confirm it controls both npmjs.org organization
  // scopes. Scope ownership is first-come-first-served and cannot be established from this repo,
  // so an anonymous index has no projection here and packing one fails.
  if (!registry.requiresAuth) {
    throw new Error(
      `app-registry-pins: the ${id} index is anonymous, but the private @mistralai / @mistral npm scopes have no anonymous projection`,
    );
  }
  // npm keys the auth line by the scheme-less registry prefix, so the token is scoped to this
  // host+path rather than every registry the app talks to.
  const authKey = registry.ts.replace(/^https:/, "");
  return [
    `# Private Mistral npm registry (${host}).`,
    "# Copy to .npmrc and provide NODE_AUTH_TOKEN (the registry pull token) via env.",
    "# .npmrc is gitignored; NEVER commit the token.",
    `@mistralai:registry=${registry.ts}`,
    `@mistral:registry=${registry.ts}`,
    `${authKey}:_authToken=\${NODE_AUTH_TOKEN}`,
    "",
  ].join("\n");
}

/** Generated, so it always closes the file: the anchor below replaces everything from it on. */
const BUNFIG_SCOPES_HEADER = [
  "# Generated by app-registry-pins.ts from this app's package index. The CLI rewrites this entry",
  "# at the end of the file when it installs capability packages, so the table stays last.",
].join("\n");
const BUNFIG_SCOPES = /^# Generated by app-registry-pins\.ts[\s\S]*$/m;

/**
 * The `[install.scopes]` table closing core's `bunfig.toml`: the app's own
 * `@mistralai-capabilities` scope, and nothing private. In package mode the CLI writes this entry
 * into a `bunfig.toml` that core's copy then replaces, so without it a later `bun add` of a
 * capability package resolves from public npm. bun expands `$NODE_AUTH_TOKEN` itself; the token is
 * never written to the file. When the CLI later installs capability packages it replaces this
 * entry and appends its own, which is why the table closes the file.
 */
export function buildBunfigScopes(id: PackageRegistryId): string {
  const registry = PACKAGE_REGISTRIES[id];
  registryUrl(id, registry.ts);
  const value = registry.requiresAuth
    ? `{ url = "${registry.ts}", token = "$NODE_AUTH_TOKEN" }`
    : `"${registry.ts}"`;
  return [
    BUNFIG_SCOPES_HEADER,
    "[install.scopes]",
    `"@mistralai-capabilities" = ${value}`,
    "",
  ].join("\n");
}

/** Bun matches `minimumReleaseAgeExcludes` names exactly (no `@scope/*` globs), so the line lists
 * literal package names. This is the reviewed inventory of private names the committed default
 * lists today. `patchMinimumReleaseAgeExcludes` below fails closed -- refusing the anonymous
 * projection -- if a future private name is added to the real file without a matching review
 * here, rather than riding along silently; a registry test exercises exactly that check against
 * the real committed file, not only a synthetic fixture, so drift surfaces at test time too. */
const REVIEWED_PRIVATE_MIN_RELEASE_AGE_EXCLUDES = new Set([
  "@mistral/workflow-ui",
  "@mistralai/ui",
]);

/** The single-line array `minimumReleaseAgeExcludes = [...]` sets. Required single-line: bun's own
 * format is one line, and a multiline or otherwise unrecognized shape fails closed below rather
 * than silently keeping (or losing) whatever it actually contains. */
const MIN_RELEASE_AGE_EXCLUDES_LINE = /^minimumReleaseAgeExcludes\s*=\s*(\[[^\]\n]*\])[ \t]*$/m;

const tomlStringArraySchema = z.object({ value: z.array(z.string()) });

/** Parse a single-line TOML array of strings, failing closed on anything else (malformed syntax,
 * a non-string entry, or a duplicate name). */
function parseTomlStringArray(raw: string, description: string): string[] {
  let toml: unknown;
  try {
    toml = Bun.TOML.parse(`value = ${raw}`);
  } catch (error) {
    throw new Error(
      `app-registry-pins: could not parse ${description} as TOML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = tomlStringArraySchema.safeParse(toml);
  if (!parsed.success) {
    throw new Error(`app-registry-pins: ${description} must be a flat array of strings`);
  }
  const { value: names } = parsed.data;
  if (new Set(names).size !== names.length) {
    throw new Error(`app-registry-pins: ${description} has a duplicate entry`);
  }
  return names;
}

/** Serialize a flat string array back into bunfig's single-line array style. */
function formatTomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/**
 * An anonymous index ships no private package, so today's reviewed private names are dropped from
 * `minimumReleaseAgeExcludes`. An exempt public-scoped name is kept; any OTHER unreviewed
 * Mistral-scoped name is a review gap, not something to silently drop or keep. Authenticated
 * indexes keep the committed line unchanged, after the same parse validates its syntax.
 */
function patchMinimumReleaseAgeExcludes(current: string, id: PackageRegistryId): string {
  const match = current.match(MIN_RELEASE_AGE_EXCLUDES_LINE);
  if (!match) {
    throw new Error(
      "app-registry-pins: could not find a single-line `minimumReleaseAgeExcludes` array in bunfig.toml",
    );
  }
  const description = "bunfig.toml's `minimumReleaseAgeExcludes`";
  const names = parseTomlStringArray(match[1]!, description);
  if (PACKAGE_REGISTRIES[id].requiresAuth) return current;

  for (const name of names) {
    if (isUnreviewedMistralPackage(name) && !REVIEWED_PRIVATE_MIN_RELEASE_AGE_EXCLUDES.has(name)) {
      throw new Error(
        `app-registry-pins: ${description} names an unreviewed Mistral-scoped package for the anonymous index: ${name}`,
      );
    }
  }
  const anonymous = names.filter((name) => !REVIEWED_PRIVATE_MIN_RELEASE_AGE_EXCLUDES.has(name));
  return current.replace(
    MIN_RELEASE_AGE_EXCLUDES_LINE,
    `minimumReleaseAgeExcludes = ${formatTomlStringArray(anonymous)}`,
  );
}

/** Replace (or append) the generated scope table that closes core's `bunfig.toml`, and project
 * `minimumReleaseAgeExcludes` for the target audience. */
export function patchRegistryBunfig(current: string, id: PackageRegistryId): string {
  const withExcludes = patchMinimumReleaseAgeExcludes(current, id);
  if (/^\[install\.scopes\]/m.test(withExcludes) && !BUNFIG_SCOPES.test(withExcludes)) {
    throw new Error(
      "app-registry-pins: bunfig.toml has an `[install.scopes]` table outside the generated block",
    );
  }
  const handWritten = withExcludes.replace(BUNFIG_SCOPES, "").replace(/\n*$/, "\n");
  const patched = `${handWritten}\n${buildBunfigScopes(id)}`;
  try {
    Bun.TOML.parse(patched);
  } catch (error) {
    throw new Error(
      `app-registry-pins: patched bunfig.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return patched;
}

/** A TOML table header. Handlebars makes the whole template unparseable as TOML, so the
 * generated uv section is transformed as lines while preserving every unrelated byte. */
const TOML_TABLE = /^\s*\[\[?[^\]]+\]?\]\s*$/;
const UV_INDEX_TABLE = /^\s*\[\[tool\.uv\.index\]\]\s*$/;
const UV_SOURCES_TABLE = /^\s*\[tool\.uv\.sources\]\s*$/;
/** A dotted source table, such as `[tool.uv.sources.private-package]`. */
const UV_DOTTED_SOURCE_TABLE = /^\s*\[tool\.uv\.sources\.[^\]]+\]\s*$/;
const MISTRALAI_INDEX_NAME = /^\s*name\s*=\s*["']mistralai["']\s*$/;
const MISTRALAI_SOURCE = /^\s*[^#\s][^=]*=\s*\{[^}]*\bindex\s*=\s*["']mistralai["'][^}]*\}\s*$/;
/** Any live TOML assignment that still binds a source to the private named index. */
const MISTRALAI_INDEX_REFERENCE = /^\s*(?!#).*\bindex\s*=\s*["']mistralai["']/m;
const UV_SCALAR_INDEX_ASSIGNMENT =
  /^\s*(?!#)(?:index-url|extra-index-url|find-links)\s*=\s*("[^"\n]*"|'[^'\n]*'|\[[\s\S]*?\])/gm;

const INTERNAL_REGISTRY_HOSTS = new Set(
  INTERNAL_PACKAGE_REGISTRY_IDS.flatMap((registryId) =>
    PACKAGE_REGISTRY_LANGUAGES.map(
      (language) => new URL(PACKAGE_REGISTRIES[registryId][language]).host,
    ),
  ),
);

function internalScalarIndexReferences(source: string): string[] {
  return [...source.matchAll(UV_SCALAR_INDEX_ASSIGNMENT)].flatMap((match) =>
    [...INTERNAL_REGISTRY_HOSTS].filter((host) => match[1]?.includes(host)),
  );
}

function lineRanges(lines: readonly string[]): { end: number; start: number }[] {
  const starts = lines.flatMap((line, index) => (TOML_TABLE.test(line) ? [index] : []));
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lines.length,
  }));
}

/**
 * Generate core's complete uv registry section for an audience.
 *
 * Authenticated registries retain the committed private index and every source binding byte for
 * byte, changing only its URL. Anonymous registries remove the named `mistralai` index and every
 * source binding to it as one operation. Bindings to the ordinary `pypi` index remain untouched.
 * The decision comes from the typed registry's `requiresAuth` property, never its username or URL.
 */
export function patchCorePyproject(current: string, id: PackageRegistryId): string {
  const registry = PACKAGE_REGISTRIES[id];
  registryUrl(id, registry.py);

  const lines = current.split("\n");
  const ranges = lineRanges(lines);
  const privateIndex = ranges.filter(
    ({ start, end }) =>
      UV_INDEX_TABLE.test(lines[start] ?? "") &&
      lines.slice(start + 1, end).some((line) => MISTRALAI_INDEX_NAME.test(line)),
  );
  if (privateIndex.length !== 1) {
    throw new Error(
      `app-registry-pins: expected exactly one \`mistralai\` uv index in core's pyproject.toml, found ${privateIndex.length}`,
    );
  }

  const privateIndexRange = privateIndex[0]!;
  if (registry.requiresAuth) {
    const { start, end } = privateIndexRange;
    const urlIndexes = lines
      .slice(start + 1, end)
      .flatMap((line, offset) =>
        /^\s*url\s*=\s*["'][^"']*["']\s*$/.test(line) ? [start + 1 + offset] : [],
      );
    if (urlIndexes.length !== 1) {
      throw new Error(
        `app-registry-pins: expected one url in the \`mistralai\` uv index, found ${urlIndexes.length}`,
      );
    }
    lines[urlIndexes[0]!] = `url = "${registry.py}"`;
    return lines.join("\n");
  }

  const sourceRange = ranges.find(({ start }) => UV_SOURCES_TABLE.test(lines[start] ?? ""));
  if (sourceRange === undefined) {
    throw new Error(
      "app-registry-pins: could not find `[tool.uv.sources]` in core's pyproject.toml",
    );
  }

  const remove = new Set<number>();
  const { start, end } = privateIndexRange;
  let privateIndexCommentStart = start;
  while (privateIndexCommentStart > 0 && /^\s*#/.test(lines[privateIndexCommentStart - 1] ?? "")) {
    privateIndexCommentStart -= 1;
  }
  for (let index = privateIndexCommentStart; index < end; index += 1) remove.add(index);
  for (let index = sourceRange.start + 1; index < sourceRange.end; index += 1) {
    if (MISTRALAI_SOURCE.test(lines[index] ?? "")) remove.add(index);
  }
  // uv also accepts a source as its own dotted table. Remove the complete table when it binds to
  // the private index; retaining only its header would leave a malformed or misleading projection.
  for (const range of ranges) {
    if (
      UV_DOTTED_SOURCE_TABLE.test(lines[range.start] ?? "") &&
      lines.slice(range.start + 1, range.end).some((line) => MISTRALAI_INDEX_REFERENCE.test(line))
    ) {
      for (let index = range.start; index < range.end; index += 1) remove.add(index);
    }
  }
  let projected = lines.filter((_, index) => !remove.has(index)).join("\n");
  // The exemptions exist because the private index serves no upload dates. An anonymous app
  // resolves from public PyPI only, which does, so every name keeps uv's recency protection.
  projected = replaceRequired(
    projected,
    /^# `= false` exempts[\s\S]*?^exclude-newer-package[ \t]*=[ \t]*\{.*\}[ \t]*\n/m,
    "",
    "the exclude-newer-package commentary",
  );
  // Fail closed if a source syntax this projection does not understand still names the credentialed
  // index, its credential variables, or a scalar uv setting aimed at an internal registry host.
  // A public core must never carry a binding that can make uv look up private credentials.
  if (MISTRALAI_INDEX_REFERENCE.test(projected) || /UV_INDEX_MISTRALAI/.test(projected)) {
    throw new Error(
      "app-registry-pins: anonymous projection retains a source bound to the `mistralai` index",
    );
  }
  const internalScalarHosts = internalScalarIndexReferences(projected);
  if (internalScalarHosts.length > 0) {
    throw new Error(
      `app-registry-pins: anonymous projection retains a scalar uv index setting for an internal registry host: ${[...new Set(internalScalarHosts)].join(", ")}`,
    );
  }
  return projected;
}

/**
 * Remove the private-index credential block from the public `tools/uv.sh` projection. The block is
 * delimited by sentinel comments in the shipped wrapper; an anonymous registry needs no pull token,
 * so the two dotenv/token readers and the credential-export branch are dropped, leaving only the
 * index pinning and the AGENT drop. Internal (authenticated) variants keep the wrapper byte for byte.
 */
const UV_PRIVATE_CREDENTIALS =
  /^# --- BEGIN private-index credentials[\s\S]*?^# --- END private-index credentials ---\n/m;

export function patchRegistryUvWrapper(current: string, id: PackageRegistryId): string {
  if (PACKAGE_REGISTRIES[id].requiresAuth) return current;
  return replaceRequired(
    current,
    UV_PRIVATE_CREDENTIALS,
    "# No package-index authentication is required for this audience.\n",
    "the private-index credential block in tools/uv.sh",
  );
}

/** Rewrite the HTTP Basic username embedded in the generated uv wrapper. */
export function patchRegistryUser(
  current: string,
  anchor: RegExp,
  render: (user: string) => string,
  id: PackageRegistryId,
): string {
  if (!anchor.test(current)) {
    throw new Error(`app-registry-pins: no registry username to rewrite (${anchor.source})`);
  }
  return replaceRequired(
    current,
    anchor,
    render(PACKAGE_REGISTRIES[id].pyUser),
    `the registry username (${anchor.source})`,
  );
}

/** Remove the authenticated-index dotenv names from an anonymous app's ignore file. */
export function patchRegistryGitignore(current: string, id: PackageRegistryId): string {
  if (PACKAGE_REGISTRIES[id].requiresAuth) return current;
  if (
    !/^\.env\.registry\n\.env\.gemfury$/m.test(current) ||
    !/^# Private registry auth \(contains tokens\)$/m.test(current)
  ) {
    throw new Error("app-registry-pins: could not find private registry ignore entries");
  }
  const withoutRegistryDotenvs = replaceRequired(
    current,
    /^\.env\.registry\n\.env\.gemfury\n/m,
    "",
    "the private registry dotenv entries",
  );
  return replaceRequired(
    withoutRegistryDotenvs,
    /^# Private registry auth \(contains tokens\)$/m,
    "# Local package-manager configuration (may contain tokens)",
    "the private registry ignore heading",
  );
}

const npmDependencyMapSchema = z.record(z.string(), z.string());

/**
 * Core's app-root `package.json` `workspaces` table: the fields this narrow projector understands
 * (npm/bun's own `packages` glob list and bun's `catalog`), plus whatever `//`-prefixed comment
 * fields it carries. `.passthrough()` keeps every comment field in the parsed value instead of
 * silently dropping it, so the projector below can inspect and selectively remove only the ones
 * mentioning a private scope.
 */
const corePackageJsonWorkspacesSchema = z
  .object({
    packages: z.array(z.string()).optional(),
    catalog: npmDependencyMapSchema.optional(),
  })
  .passthrough();

/**
 * Core's app-root `package.json`: the top-level fields this narrow projector understands, plus
 * `//`-prefixed comments (kept via `.passthrough()` for the same reason as `workspaces` above). A
 * field outside this set -- comment-shaped or not -- is a shape this projector was not reviewed
 * for, so parsing fails closed on it rather than passing it through untouched.
 */
const corePackageJsonSchema = z
  .object({
    name: z.string().min(1),
    private: z.boolean().optional(),
    type: z.string().optional(),
    workspaces: corePackageJsonWorkspacesSchema.optional(),
    scripts: npmDependencyMapSchema.optional(),
    dependencies: npmDependencyMapSchema.optional(),
    devDependencies: npmDependencyMapSchema.optional(),
    optionalDependencies: npmDependencyMapSchema.optional(),
    peerDependencies: npmDependencyMapSchema.optional(),
    overrides: npmDependencyMapSchema.optional(),
    resolutions: npmDependencyMapSchema.optional(),
    packageManager: z.string().optional(),
  })
  .passthrough();

type CorePackageJson = z.infer<typeof corePackageJsonSchema>;
type CorePackageJsonWorkspaces = z.infer<typeof corePackageJsonWorkspacesSchema>;

const CORE_PACKAGE_JSON_KNOWN_KEYS = new Set(Object.keys(corePackageJsonSchema.shape));
const CORE_PACKAGE_JSON_WORKSPACES_KNOWN_KEYS = new Set(
  Object.keys(corePackageJsonWorkspacesSchema.shape),
);

const isCommentKey = (key: string): boolean => key.startsWith("//");

/**
 * The `//`-prefixed comment entries of an already-shape-validated object, beyond its known keys.
 * Any other extra key -- comment-shaped or not, or a `//`-prefixed key whose value is not a
 * string -- is a field this projector was not reviewed for, and fails closed instead of silently
 * dropping or silently keeping it.
 */
function commentEntries(
  source: CorePackageJson | CorePackageJsonWorkspaces,
  known: ReadonlySet<string>,
  description: string,
): ReadonlyArray<readonly [string, string]> {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key)) continue;
    const comment = z.string().safeParse(value);
    if (!isCommentKey(key) || !comment.success) {
      throw new Error(`app-registry-pins: ${description} has an unrecognized field \`${key}\``);
    }
    entries.push([key, comment.data]);
  }
  return entries;
}

/**
 * Parse and shape-validate core's `package.json`, failing closed on anything this narrow
 * projector was not reviewed to handle: malformed JSON, an unrecognized top-level or `workspaces`
 * field, or a `workspaces.packages`/dependency-map field of the wrong shape. This projector is
 * registered only for core's carrier (the only manifest that lists `package.json` in
 * `metadata.registryPins`), but is otherwise a plain function of its input; a misconfigured
 * carrier that lists this pin for a package.json of a shape this function does not recognize gets
 * a clear failure here rather than a silently wrong transformation.
 *
 * Returns the plain `JSON.parse` result, not zod's `.passthrough()` reconstruction: neither
 * schema above declares a default, coercion, or transform, so a successful `safeParse` guarantees
 * the raw parse already has the validated shape. Reading it directly (rather than `parsed.data`)
 * keeps the file's own top-level and `workspaces` key order, which `.passthrough()` does not --
 * it rebuilds the object with its schema-declared keys first and every extra (comment) key
 * appended after. The anonymous projection needs that original order to stay a minimal diff
 * instead of silently reordering every field around whichever ones it touched.
 */
function parseCorePackageJson(source: string): CorePackageJson {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `app-registry-pins: core's package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = corePackageJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `app-registry-pins: core's package.json has an unexpected shape: ${z.prettifyError(parsed.error)}`,
    );
  }
  // SAFETY: `corePackageJsonSchema` only validates shape (a ZodObject on a non-object input
  // fails, and neither schema declares a default/coerce/transform), so a successful parse
  // guarantees `raw` is itself a `CorePackageJson`, in its own (pre-`.passthrough()`) key order.
  const manifest = raw as CorePackageJson;
  commentEntries(manifest, CORE_PACKAGE_JSON_KNOWN_KEYS, "core's package.json");
  if (manifest.workspaces !== undefined) {
    commentEntries(
      manifest.workspaces,
      CORE_PACKAGE_JSON_WORKSPACES_KNOWN_KEYS,
      "core's package.json `workspaces`",
    );
  }
  return manifest;
}

/**
 * Real dependency entries name packages an app actually installs. Dropping a private one would
 * silently break the app, so the anonymous projection may only fail on it, never strip it
 * (`workspaces.catalog` entries are real dependency versions too, referenced by `catalog:` in
 * `dependencies`/`devDependencies`).
 */
function assertNoPrivateDependency(
  entries: Record<string, string> | undefined,
  description: string,
): void {
  if (entries === undefined) return;
  const offenders = Object.keys(entries).filter(isUnreviewedMistralPackage);
  if (offenders.length > 0) {
    throw new Error(
      `app-registry-pins: core's package.json ${description} names an unreviewed Mistral-scoped npm package with no anonymous projection: ${offenders.join(", ")}`,
    );
  }
}

/**
 * Drop unreviewed Mistral-scoped entries from a pin-style map (`overrides`/`resolutions`): these override what
 * an authenticated index resolves for a transitive dependency, rather than declaring a workspace
 * member's own dependency, so dropping the entry (rather than failing) is safe -- an anonymous app
 * resolves the un-overridden public version instead.
 */
function withoutPrivateScope(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(([name]) => !isUnreviewedMistralPackage(name)),
  );
}

/** Drop `//`-prefixed comment fields that mention an unreviewed Mistral package from core's package.json; every
 * other comment (and every other key, in its original position) is returned untouched. */
function withoutPrivateManifestComments(manifest: CorePackageJson): CorePackageJson {
  const result = { ...manifest };
  for (const [key, value] of commentEntries(
    manifest,
    CORE_PACKAGE_JSON_KNOWN_KEYS,
    "core's package.json",
  )) {
    if (hasUnreviewedMistralMention(value)) delete result[key];
  }
  return result;
}

/** The `workspaces`-scoped counterpart of `withoutPrivateManifestComments`, for the `//packages`
 * comment nested under `workspaces`. */
function withoutPrivateWorkspacesComments(
  workspaces: CorePackageJsonWorkspaces,
): CorePackageJsonWorkspaces {
  const result = { ...workspaces };
  for (const [key, value] of commentEntries(
    workspaces,
    CORE_PACKAGE_JSON_WORKSPACES_KNOWN_KEYS,
    "core's package.json `workspaces`",
  )) {
    if (hasUnreviewedMistralMention(value)) delete result[key];
  }
  return result;
}

/**
 * Core's app-root `package.json`.
 *
 * Authenticated indexes get the canonical bytes back unchanged (parsing above only validates the
 * shape this projector understands; it never reserializes an authenticated input). The anonymous
 * public index gets a deterministic re-serialization that removes private `@mistral/*` /
 * `@mistralai/*` entries from `overrides` and `resolutions`, and any `//` comment mentioning those
 * scopes, except exact names reviewed as public on anonymous npm. It leaves workspace globs, the
 * catalog, scripts (`dev:web` included), real dependencies, and `packageManager` untouched. Output
 * key order follows the canonical file so the anonymous diff is exactly the removed entries. An
 * unreviewed Mistral-scoped name in a real dependency or catalog fails rather than silently
 * dropping it; so does any unreviewed scope mention left in the serialized output.
 */
export function patchCorePackageJson(current: string, id: PackageRegistryId): string {
  const manifest = parseCorePackageJson(current);
  if (PACKAGE_REGISTRIES[id].requiresAuth) return current;

  assertNoPrivateDependency(manifest.dependencies, "dependencies");
  assertNoPrivateDependency(manifest.devDependencies, "devDependencies");
  assertNoPrivateDependency(manifest.optionalDependencies, "optionalDependencies");
  assertNoPrivateDependency(manifest.peerDependencies, "peerDependencies");
  assertNoPrivateDependency(manifest.workspaces?.catalog, "workspaces.catalog");

  const projected = withoutPrivateManifestComments(manifest);
  if (projected.overrides !== undefined) {
    projected.overrides = withoutPrivateScope(projected.overrides);
  }
  if (projected.resolutions !== undefined) {
    projected.resolutions = withoutPrivateScope(projected.resolutions);
  }
  if (manifest.workspaces !== undefined) {
    projected.workspaces = withoutPrivateWorkspacesComments(manifest.workspaces);
  }

  const serialized = `${JSON.stringify(projected, null, 2)}\n`;
  if (hasUnreviewedMistralMention(serialized)) {
    throw new Error(
      "app-registry-pins: the anonymous projection of core's package.json still names an unreviewed Mistral-scoped npm package",
    );
  }
  return serialized;
}

/** A template file projected per index, by its path in a carrier's template zone. */
interface RegistryPin {
  readonly rel: string;
  readonly project: (canonical: string, id: PackageRegistryId) => string;
}

/** The projector for each template path a carrier may list in `metadata.registryPins`. */
export const REGISTRY_PINS: readonly RegistryPin[] = [
  { rel: ".npmrc.hbs", project: (_, id) => buildNpmrc(id) },
  { rel: ".npmrc.example", project: (_, id) => buildNpmrc(id) },
  { rel: "bunfig.toml", project: patchRegistryBunfig },
  { rel: "package.json", project: patchCorePackageJson },
  { rel: "pyproject.toml", project: patchCorePyproject },
  { rel: "gitignore", project: patchRegistryGitignore },
  {
    rel: join("tools", "uv.sh"),
    project: (canonical, id) =>
      patchRegistryUvWrapper(
        patchRegistryUser(
          canonical,
          /^export MISTRAL_REGISTRY_USER=.*$/m,
          (user) => `export MISTRAL_REGISTRY_USER=${user}`,
          id,
        ),
        id,
      ),
  },
];

export interface RegistryPinCarrier {
  readonly manifest: CapabilityManifest;
  readonly template: string;
  /** The hand-authored bytes of each file the carrier lists, keyed by its template path. */
  readonly canonical: ReadonlyMap<string, string>;
}

/** Read every carrier's hand-authored inputs before any generated file is written. */
export function readRegistryPinCarriers(
  repoRoot: string = process.cwd(),
  manifests: readonly CapabilityManifest[] = readManifests(repoRoot),
): RegistryPinCarrier[] {
  return registryPinCarriers(manifests).map((manifest) => {
    const template = join(repoRoot, "capabilities", manifest.path, "template");
    const canonical = new Map(
      (manifest.metadata?.registryPins ?? []).map((rel): [string, string] => {
        if (!REGISTRY_PINS.some((pin) => pin.rel === rel)) {
          throw new Error(
            `app-registry-pins: ${manifest.path} lists ${rel} in metadata.registryPins, which has no projector (known: ${REGISTRY_PINS.map((pin) => pin.rel).join(", ")})`,
          );
        }
        // patchCorePackageJson assumes Core's manifest shape (corePackageJsonSchema); routing any
        // other carrier's package.json through it would silently misapply that schema.
        if (rel === "package.json" && !(manifest.kind === "base" && manifest.id === "core")) {
          throw new Error(
            `app-registry-pins: ${manifest.path} lists package.json in metadata.registryPins, but its projector only supports Core's manifest shape`,
          );
        }
        if (!existsSync(join(template, rel))) {
          throw new Error(
            `app-registry-pins: ${manifest.path} lists ${rel} in metadata.registryPins but its template does not ship it`,
          );
        }
        return [rel, readFileSync(join(template, rel), "utf8")];
      }),
    );
    return { manifest, template, canonical };
  });
}

/**
 * The pinned files and their content for `id`, written under `template` (a carrier's template or
 * a staged copy of it). Every generator closes over the canonical content rather than re-reading
 * its destination, so destructive anonymous projections cannot become an authenticated variant's
 * source by accident.
 */
export function registryPins(
  id: PackageRegistryId,
  canonical: ReadonlyMap<string, string>,
  template: string,
): GeneratedFile[] {
  return REGISTRY_PINS.flatMap(({ rel, project }) => {
    const source = canonical.get(rel);
    return source === undefined
      ? []
      : [{ path: join(template, rel), generate: () => project(source, id) }];
  });
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  // Each generator is pure and throws, so it stays importable from a test; the CLI is the
  // only place that turns a failure into an exit code.
  let fresh: boolean;
  try {
    const pins = readRegistryPinCarriers().flatMap(({ canonical, template }) =>
      registryPins(DEFAULT_PACKAGE_REGISTRY, canonical, template),
    );
    fresh = await syncGeneratedFiles(pins, check);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!fresh) process.exit(1);
  if (check) console.log("app registry pins are up to date.");
}

// Only run when executed directly. Importing (for example from the registry tests) just
// loads the generators without touching the filesystem.
if (import.meta.main) {
  await main();
}
