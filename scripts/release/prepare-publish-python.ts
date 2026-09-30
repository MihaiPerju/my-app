#!/usr/bin/env bun
/**
 * prepare-publish-python.ts — stamp the release version onto every Python
 * capability distribution before publishing to the private PyPI index. Mirrors
 * `prepare-publish.ts` for npm, keeping the npm and PyPI versions in lockstep.
 * Rewrites `[project].version` in each `package/py/pyproject.toml`, and bundles
 * the repo-root `LICENSE` beside the pyprojects the Apache-2.0 grant covers so
 * their `license-files` glob resolves. uv_build silently skips a glob that
 * matches nothing, so a missing copy would produce a wheel with no licence text
 * rather than a build failure.
 *
 *   bun scripts/release/prepare-publish-python.ts <version>
 */

import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { localCapabilityId } from "../shared/capability-identity";
import { readManifests } from "../shared/manifests";
import {
  PRIVATE_PYTHON_LICENSE,
  PUBLIC_LICENSE,
  publicCapabilityIds,
  readPythonLicense,
} from "./licensing";

const version = process.argv[2];
if (!version) {
  console.error("usage: prepare-publish-python.ts <version>");
  process.exit(1);
}

/**
 * Replace `[project].version` in a `pyproject.toml` source. Scans only the
 * `[project]` table body, so a `version` in a later table is untouched. Throws
 * when the `[project]` table has no `version` key.
 */
function setProjectVersion(src: string, next: string): string {
  const header = /^\s*\[project\]\s*$/m.exec(src);
  if (!header) throw new Error("no [project] table");
  const bodyStart = header.index + header[0].length;
  const rest = src.slice(bodyStart);
  const nextTable = /^\s*\[/m.exec(rest);
  const bodyEnd = nextTable ? bodyStart + nextTable.index : src.length;
  const body = src.slice(bodyStart, bodyEnd);
  const versionRe = /^(\s*version\s*=\s*)["'][^"']*["']/m;
  if (!versionRe.test(body)) throw new Error("no [project].version key");
  const newBody = body.replace(versionRe, `$1"${next}"`);
  return src.slice(0, bodyStart) + newBody + src.slice(bodyEnd);
}

/**
 * Reject a pyproject whose declared licence disagrees with whether this script
 * will stage the text beside it. A private dist declaring `Apache-2.0` would
 * offer terms the repository did not mean to offer, and a public one that keeps
 * no `license-files` entry builds a wheel with the expression but no text.
 */
function assertLicenseDeclaration(src: string, path: string, isPublic: boolean): void {
  const declaration = readPythonLicense(src);
  const expected = isPublic ? PUBLIC_LICENSE : PRIVATE_PYTHON_LICENSE;
  if (declaration.license !== expected) {
    throw new Error(
      `${path}: ${isPublic ? "public" : "private"} distribution must declare license = "${expected}", got ${JSON.stringify(declaration.license ?? null)}`,
    );
  }
  const files = declaration["license-files"];
  if (isPublic) {
    if (!Array.isArray(files) || !files.includes("LICENSE")) {
      throw new Error(`${path}: public distribution must declare license-files = ["LICENSE"]`);
    }
  } else if (files !== undefined) {
    throw new Error(
      `${path}: private distribution must not declare license-files; no licence text is staged for it`,
    );
  }
}

const root = process.cwd();
const capsDir = join(root, "capabilities");
const rootLicense = join(root, "LICENSE");
if (!existsSync(rootLicense)) {
  console.error(`${rootLicense} is missing; published distributions would carry no licence text.`);
  process.exit(1);
}
// Only walk roots when the tier exists; readManifests would throw ENOENT otherwise.
const capabilityManifests = existsSync(capsDir) ? readManifests(root) : [];
const publicIds = publicCapabilityIds(capabilityManifests);
// Two-phase, all-or-nothing: parse and rewrite every pyproject in memory first
// (setProjectVersion throws on a malformed [project] table), then write. A
// malformed pyproject found late aborts before any file is touched, so a failed
// run never leaves the tree half-stamped.
const planned: {
  dist: string;
  isPublic: boolean;
  pyDir: string;
  pyproject: string;
  contents: string;
}[] = [];
for (const manifest of capabilityManifests) {
  // Roots are discovered recursively, so a nested `capabilities/<group>/<id>`
  // is stamped the same as a flat one; `id` is the globally-unique name.
  const pyDir = join(capsDir, manifest.path, "package/py");
  const pyproject = join(pyDir, "pyproject.toml");
  if (!existsSync(pyproject) || !statSync(pyproject).isFile()) continue;
  const src = readFileSync(pyproject, "utf8");
  const isPublic = publicIds.has(localCapabilityId(manifest));
  assertLicenseDeclaration(src, pyproject, isPublic);
  const contents = setProjectVersion(src, version);
  const dist =
    /^\s*name\s*=\s*["']([^"']+)["']/m.exec(src.split(/^\s*\[/m)[1] ?? "")?.[1] ?? manifest.id;
  planned.push({ dist, isPublic, pyDir, pyproject, contents });
}

// Every pyproject parsed and rewritten — apply the writes.
for (const p of planned) {
  writeFileSync(p.pyproject, p.contents);
  // Removing matters as much as copying: a copy left by an earlier run, from before the capability
  // went private, would sit beside a pyproject that no longer points at it and land in the sdist.
  if (p.isPublic) copyFileSync(rootLicense, join(p.pyDir, "LICENSE"));
  else rmSync(join(p.pyDir, "LICENSE"), { force: true });
  console.log(`prepared ${p.dist} py dist @ ${version}${p.isPublic ? "" : " (proprietary)"}`);
}
console.log(`prepared ${planned.length} Python capability dist(s) at version ${version}`);
