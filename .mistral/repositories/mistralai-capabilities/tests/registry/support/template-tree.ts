/**
 * Shared traversal of the capability template zones.
 *
 * The inventory guard and the collision guard walk the tree through this one implementation, so
 * they cannot disagree about what a capability contributes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  type CapabilityIdentity,
  localCapabilityId,
  npmCapabilityName,
  pyCapabilityName,
} from "../../../scripts/shared/capability-identity";
import { readCapabilityRoots } from "../../../scripts/shared/manifests";

export const REGISTRY_ROOT = resolve(import.meta.dir, "..", "..", "..");
export const CAPABILITIES_DIR = join(REGISTRY_ROOT, "capabilities");

// SAFETY: T is the caller's schema for a repo-controlled JSON file; a mismatch fails the test reading it.
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export const capabilityRoots = readCapabilityRoots(REGISTRY_ROOT);
/** The one canonical enumeration: every capability's kind-qualified local id (`<kind>/<id>`). */
export const capabilityLocalIds = capabilityRoots.map((root) => localCapabilityId(root));

/**
 * Resolve a capability handle — a bare leaf id (when unique) or a `kind/id` local id — to its
 * identity. A bare leaf that matches more than one kind is ambiguous; an unknown handle throws.
 * This mirrors the CLI's short-selector policy and lets directory helpers take either form.
 */
export const identityOf = (ref: string): CapabilityIdentity => {
  if (ref.includes("/")) {
    const [kind, id] = ref.split("/");
    const found = capabilityRoots.find((root) => root.kind === kind && root.id === id);
    if (found === undefined) throw new Error(`unknown capability \`${ref}\``);
    return { kind: found.kind, id: found.id };
  }
  const matches = capabilityRoots.filter((root) => root.id === ref);
  const [match] = matches;
  if (match === undefined) throw new Error(`unknown capability id \`${ref}\``);
  if (matches.length > 1) {
    throw new Error(
      `ambiguous capability id \`${ref}\`; use one of: ${matches
        .map((m) => localCapabilityId(m))
        .toSorted()
        .join(", ")}.`,
    );
  }
  return { kind: match.kind, id: match.id };
};

export const capabilityDir = (ref: string): string => {
  const identity = identityOf(ref);
  return join(CAPABILITIES_DIR, localCapabilityId(identity));
};

export const templateDir = (ref: string) => join(capabilityDir(ref), "template");

export function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    // Also an ignore rule, but `walk` has callers that scan file CONTENT (the sentinel and Helm
    // guards): descending into a stray local install would be slow and would grade vendor code.
    if (entry === "node_modules") return [];
    const path = join(root, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The repo-root `.templateignore`, compiled to matchers.
 *
 * This file is the single source of truth for what is not vendored, so compiling it here makes the
 * inventory a statement about what a generated app receives. `assertSupported` rejects any syntax
 * the compiler does not support, so an unmatched rule cannot silently under-apply.
 */
function compileIgnore(): { re: RegExp; negated: boolean }[] {
  const raw = readFileSync(join(REGISTRY_ROOT, ".templateignore"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      let pattern = negated ? line.slice(1) : line;

      if (/\[|\]|\\/.test(pattern)) {
        throw new Error(`.templateignore uses unsupported syntax and would under-apply: ${line}`);
      }

      const dirOnly = pattern.endsWith("/");
      if (dirOnly) pattern = pattern.slice(0, -1);

      // gitignore: a pattern containing a slash is anchored to the root; one without matches a
      // basename at any depth.
      const anchored = pattern.includes("/");
      if (pattern.startsWith("/")) pattern = pattern.slice(1);

      const body = pattern
        .split("/")
        .map((segment) =>
          segment === "**"
            ? "§§"
            : segment
                .replaceAll(/[.+^${}()|]/g, String.raw`\$&`)
                .replaceAll("*", "[^/]*")
                .replaceAll("?", "[^/]"),
        )
        .join("/")
        .replaceAll("§§/", "(?:.*/)?")
        .replaceAll("§§", ".*");

      // A trailing slash matches directories only. `isVendored` is asked about files, so such a
      // rule must have at least one descendant segment; a same-named file remains vendored.
      // A non-directory pattern may itself match a directory, whose descendants are then ignored.
      const tail = dirOnly ? "/.+$" : "(?:/.*)?$";
      return {
        re: new RegExp(anchored ? `^${body}${tail}` : `^(?:.*/)?${body}${tail}`),
        negated,
      };
    });
}

const IGNORE_RULES = compileIgnore();

/** gitignore semantics: the LAST matching rule wins, so a later `!` rule can re-include. */
export function isVendored(rel: string): boolean {
  let ignored = false;
  for (const rule of IGNORE_RULES) {
    if (rule.re.test(rel)) ignored = !rule.negated;
  }
  return !ignored;
}

/**
 * Every path a capability contributes to a generated app: the template tree minus what
 * `.templateignore` withholds, with `.hbs` resolved to its output name.
 */
export function contributedPaths(id: string): string[] {
  const root = templateDir(id);
  return walk(root)
    .map((path) => relative(root, path))
    .filter(isVendored)
    .map((rel) => (rel.endsWith(".hbs") ? rel.slice(0, -".hbs".length) : rel));
}

/**
 * A parsed, validated `project.json`: its NX project name and the target names it declares. NX
 * discovers a project by the presence of its `project.json`, so a capability's command surface is
 * the targets across the `project.json` files its template ships — the direct analog of the old
 * Invoke `@task` surface, now that NX drives the workspace. A colocated `package.json`'s scripts are
 * NX-inferred targets too; `appCommands` folds those in per project.
 */
export interface ProjectManifest {
  readonly name: string;
  readonly targetNames: readonly string[];
}

/** Parse a `project.json` and validate the fields the command surface reads. */
export function parseProjectManifest(
  projectJson: string,
  source = "project.json",
): ProjectManifest {
  // SAFETY: repo-owned project.json; the required `name`/`targets` are checked immediately below.
  const parsed = JSON.parse(projectJson) as {
    name?: string;
    targets?: Record<string, { executor?: string }>;
  };
  if (!parsed.name) throw new Error(`${source}: project.json needs a non-empty "name"`);
  if (!parsed.targets) throw new Error(`${source}: project.json needs a "targets" object`);
  return { name: parsed.name, targetNames: Object.keys(parsed.targets) };
}

/** The declared targets of a `project.json`, as `<project>:<target>` handles. */
export function projectTargets(projectJson: string, source = "project.json"): string[] {
  const { name, targetNames } = parseProjectManifest(projectJson, source);
  return targetNames.map((target) => `${name}:${target}`);
}

/** The script names NX infers as targets from a colocated package.json (its `scripts` keys). */
export function packageScripts(packageJson: string): string[] {
  // SAFETY: repo-owned package.json; `scripts` is an optional string map when present.
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  return Object.keys(parsed.scripts ?? {});
}

/**
 * PEP 503 name normalization: lowercase, runs of `-`/`_`/`.` collapsed to one `-`.
 *
 * Mirrors the CLI's `normalizePyDistName`, so the registry and the generator agree on names like
 * `foo_bar` and `Foo.Bar`. It lives here because three separate guards compare distribution names
 * and a second copy of this rule is a second way for them to disagree.
 */
export const normalizePyDistName = (name: string): string =>
  name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * The dist name the CLI writes for a capability: `<registry>-<kind>-<id>`, PEP 503 normalized.
 * Accepts a bare leaf (resolved uniquely) or a `kind/id` handle.
 */
export const pyDistNameFor = (registryId: string, ref: string): string =>
  pyCapabilityName(registryId, identityOf(ref));

/**
 * The npm package name the CLI writes for a capability: `@<registry>/<kind>-<id>`. Accepts a bare
 * leaf (resolved uniquely) or a `kind/id` handle.
 */
export const npmPkgNameFor = (registryId: string, ref: string): string =>
  npmCapabilityName(registryId, identityOf(ref));

/**
 * The project name out of a PEP 508 requirement string, normalized.
 *
 * Splits on the first character that can end a name: an extras bracket, a version operator, a
 * marker semicolon, a direct-reference `@`, or whitespace. That covers `pkg[extra]>=1`,
 * `pkg==1.0`, `pkg ; python_version < "3.14"` and `pkg@file:///x`.
 */
export const requirementName = (requirement: string): string =>
  normalizePyDistName(requirement.split(/[[<>=!~;@\s]/)[0] ?? "");
