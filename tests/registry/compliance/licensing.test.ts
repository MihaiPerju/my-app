/**
 * The licence declarations every published artifact carries.
 *
 * The grant is scoped to what actually leaves the repository. A capability marked `metadata.public`
 * ships to npmjs.org and PyPI under Apache-2.0; everything else goes to Gemfury and Cloudsmith for
 * consumers who already hold a separate agreement, so it declares itself proprietary and carries no
 * licence text. Both halves are asserted: a table of only public rows would pass while the whole
 * registry is private, which is exactly the state it is in today.
 *
 * The Apache text itself is tracked once at the repo root and staged into the public packages at
 * prepare time, so nothing here asserts a per-package copy in the source tree. What a manifest must
 * declare is the SPDX expression, because that is the field npm and PyPI render and neither build
 * step invents it: `uv_build` skips a `license-files` glob that matches nothing, and `npm pack` is
 * happy with a manifest that has no `license` at all.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { sha256 } from "../../../scripts/compliance/archive-scanner";
import { licensedArtifact } from "../../../scripts/compliance/check-public-artifacts";
import {
  PRIVATE_NPM_LICENSE,
  PRIVATE_PYTHON_LICENSE,
  PUBLIC_LICENSE,
  publicCapabilityIds,
  publiclyLicensed,
  readPythonLicense,
} from "../../../scripts/release/licensing";
import { scanPackageManifests } from "../../../scripts/release/package-manifests";
import { localCapabilityId } from "../../../scripts/shared/capability-identity";
import { readManifests } from "../../../scripts/shared/manifests";
import { REGISTRY_ROOT } from "../support/template-tree";

const capabilityManifests = readManifests(REGISTRY_ROOT);
const publicIds = publicCapabilityIds(capabilityManifests);

const npmManifests = scanPackageManifests(REGISTRY_ROOT, capabilityManifests)
  .filter(({ publishable }) => publishable)
  .map((manifest) => ({
    isPublic: publiclyLicensed(manifest, publicIds),
    manifestPath: manifest.manifestPath,
    name: manifest.name,
  }));

const pyProjects = capabilityManifests
  .map((manifest) => ({
    isPublic: publicIds.has(localCapabilityId(manifest)),
    pyproject: join(REGISTRY_ROOT, "capabilities", manifest.path, "package/py/pyproject.toml"),
  }))
  .filter(({ pyproject }) => existsSync(pyproject))
  .map((entry) => ({ ...entry, name: relative(REGISTRY_ROOT, entry.pyproject) }));

const publicNpm = npmManifests.filter(({ isPublic }) => isPublic);
const privateNpm = npmManifests.filter(({ isPublic }) => !isPublic);
const publicPy = pyProjects.filter(({ isPublic }) => isPublic);
const privatePy = pyProjects.filter(({ isPublic }) => !isPublic);

describe("licence declarations", () => {
  test("the repo root carries the licence text the public packages are staged from", () => {
    expect(readFileSync(join(REGISTRY_ROOT, "LICENSE"), "utf8")).toContain("Apache License");
  });

  // Either half going empty makes its table vacuous. The public npm row is the descriptor, which is
  // public whatever the capabilities are; there is no public Python distribution yet.
  test("both halves of the npm table have rows to check", () => {
    expect(publicNpm.length).toBeGreaterThan(0);
    expect(privateNpm.length).toBeGreaterThan(0);
  });

  test("the private Python table has rows to check", () => {
    expect(privatePy.length).toBeGreaterThan(0);
  });

  test.each(publicNpm)("$name is public and declares Apache-2.0", ({ manifestPath }) => {
    // SAFETY: a publishable package.json, already parsed once by scanPackageManifests.
    const json = JSON.parse(readFileSync(manifestPath, "utf8")) as { license?: string };
    expect(json.license).toBe(PUBLIC_LICENSE);
  });

  test.each(privateNpm)("$name is private and grants nothing", ({ manifestPath }) => {
    // SAFETY: a publishable package.json, already parsed once by scanPackageManifests.
    const json = JSON.parse(readFileSync(manifestPath, "utf8")) as { license?: string };
    expect(json.license).toBe(PRIVATE_NPM_LICENSE);
  });

  test.each(publicPy)("$name is public and bundles the licence text", ({ pyproject }) => {
    const declaration = readPythonLicense(readFileSync(pyproject, "utf8"));
    expect(declaration.license).toBe(PUBLIC_LICENSE);
    expect(declaration["license-files"]).toEqual(["LICENSE"]);
  });

  test.each(privatePy)("$name is private and grants nothing", ({ pyproject }) => {
    const declaration = readPythonLicense(readFileSync(pyproject, "utf8"));
    // `UNLICENSED` is npm's spelling and not valid SPDX, which uv would reject.
    expect(declaration.license).toBe(PRIVATE_PYTHON_LICENSE);
    // No text is staged beside a private dist, and uv_build skips a glob that matches nothing, so
    // leaving the key would silently build a wheel claiming a licence file it does not carry.
    expect(declaration["license-files"]).toBeUndefined();
  });

  // Both staging destinations, because the two prepare scripts write to different ones: the npm
  // side to the capability root, the Python side beside the pyproject.
  test("no capability tracks its own copy of the licence text", () => {
    const tracked = capabilityManifests
      .flatMap(({ path }) => [
        join("capabilities", path, "LICENSE"),
        join("capabilities", path, "package/py/LICENSE"),
      ])
      .filter((path) => existsSync(join(REGISTRY_ROOT, path)));
    expect(tracked).toEqual([]);
  });
});

describe("publiclyLicensed", () => {
  const ids = publicCapabilityIds([
    { id: "open", kind: "feature", metadata: { public: true }, path: "feature/open", version: "0" },
    {
      id: "shut",
      kind: "feature",
      metadata: { public: false },
      path: "feature/shut",
      version: "0",
    },
    { id: "mute", kind: "feature", path: "feature/mute", version: "0" },
  ]);

  const cases = [
    {
      case: "a public capability",
      expected: true,
      pkg: { capability: { id: "open", kind: "feature" }, name: "x" },
    },
    {
      case: "a private capability",
      expected: false,
      pkg: { capability: { id: "shut", kind: "feature" }, name: "x" },
    },
    // An absent flag is consumer-false; publication-check.ts is what rejects authoring it.
    {
      case: "a capability with no flag",
      expected: false,
      pkg: { capability: { id: "mute", kind: "feature" }, name: "x" },
    },
    // Same id under another kind is a different capability.
    {
      case: "a same-id capability of another kind",
      expected: false,
      pkg: { capability: { id: "open", kind: "base" }, name: "x" },
    },
    {
      case: "the descriptor package",
      expected: true,
      pkg: { capability: undefined, name: "@mistralai-capabilities/registry" },
    },
    {
      case: "an unlisted shared package",
      expected: false,
      pkg: { capability: undefined, name: "@mistralai-capabilities/config" },
    },
  ];

  test.each(cases)("$case", ({ expected, pkg }) => {
    expect(publiclyLicensed(pkg, ids)).toBe(expected);
  });
});

describe("licensedArtifact", () => {
  const ours = sha256(Buffer.from("Apache License\nVersion 2.0\n"));
  const theirs = sha256(Buffer.from("Some other licence\n"));

  const present = [
    {
      case: "an npm tarball",
      members: [
        { name: "package" },
        { digest: theirs, name: "package/package.json" },
        { digest: ours, name: "package/LICENSE" },
      ],
    },
    {
      case: "an sdist",
      members: [{ name: "cap-1.2.3" }, { digest: ours, name: "cap-1.2.3/LICENSE" }],
    },
    {
      case: "a wheel",
      members: [
        { name: "cap-1.2.3.dist-info" },
        { digest: ours, name: "cap-1.2.3.dist-info/licenses/LICENSE" },
      ],
    },
  ];
  const absent = [
    { case: "no licence member at all", members: [{ digest: theirs, name: "package/a.json" }] },
    {
      case: "a differently-named licence",
      members: [{ digest: ours, name: "package/LICENSE.md" }],
    },
    {
      case: "a suffixed sibling",
      members: [{ digest: ours, name: "package/THIRD-PARTY-LICENSE" }],
    },
    // A directory or symlink carries no digest, so it cannot stand in for the text.
    { case: "a directory of that name", members: [{ name: "package/LICENSE" }] },
    { case: "a different licence text", members: [{ digest: theirs, name: "package/LICENSE" }] },
  ];

  test.each(present)("accepts $case", ({ members }) => {
    expect(licensedArtifact(members, ours)).toBe(true);
  });

  test.each(absent)("rejects $case", ({ members }) => {
    expect(licensedArtifact(members, ours)).toBe(false);
  });
});
