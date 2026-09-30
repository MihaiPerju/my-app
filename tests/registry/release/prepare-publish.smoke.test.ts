/**
 * Smoke test for the prepare-publish orchestration script: it builds a throwaway workspace and
 * runs the real prepare-publish.ts as a subprocess, so actual fs behaviour runs, not a stub.
 *
 * It catches a regression in how a publishable manifest is stamped: version not applied, `private`
 * left in, `workspace:*` or `catalog:` specs shipped unresolved, the build-only `config` package
 * published by mistake, or an unresolvable `catalog:` ignored instead of failing the release.
 * Capability roots live at `capabilities/<kind>/<id>` and publish as `@<registry>/<kind>-<id>`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REGISTRY_ROOT } from "../support/template-tree";

const SCRIPT = join(REGISTRY_ROOT, "scripts", "release", "prepare-publish.ts");
const SCOPE = "@mistralai-capabilities";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

let root: string;

/** Write `value` as pretty JSON to `<root>/<rel>`, creating parent dirs. */
function writeJson(rel: string, value: JsonValue): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson<T = JsonValue>(rel: string): T {
  // SAFETY: T is the caller's schema for a file this test just wrote; a mismatch fails the assertions.
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
}

function run(...args: string[]) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cap-prepare-"));

  // Root workspace manifest: prepare-publish reads only `workspaces.catalog` from it.
  writeJson("package.json", {
    name: "mistralai-capabilities",
    private: true,
    workspaces: { packages: ["packages/*", "capabilities/*/*"], catalog: { zod: "^4.1.13" } },
  });
  // A template zone earns a bundled .templateignore, so give the repo one to bundle.
  writeFileSync(join(root, ".templateignore"), "__tests__/\n*.test.ts\n");
  writeFileSync(join(root, "LICENSE"), "Apache License\nVersion 2.0\n");

  // A shared package in audio's closure. Not on PUBLIC_SHARED_PACKAGES, so it grants nothing.
  writeJson("packages/shared/package.json", {
    name: `${SCOPE}/shared`,
    version: "0.2.0",
    private: true,
    license: "UNLICENSED",
  });
  // The build-only config package (SKIP_PUBLISH): discovered but never stamped.
  writeJson("packages/config/package.json", { name: `${SCOPE}/config`, version: "1.0.0" });

  // A capability at feature/audio: private, versionless, with workspace:/catalog: deps and a
  // template zone. It declares the `ts` transport, so the release scan requires its npm
  // package.json named for its kind-qualified identity `@<scope>/feature-audio`.
  writeJson("capabilities/feature/audio/capability.json", {
    id: "audio",
    version: "0.1.0",
    kind: "feature",
    packages: ["ts"],
    metadata: { public: true },
  });
  writeJson("capabilities/feature/audio/package.json", {
    name: `${SCOPE}/feature-audio`,
    version: "0.0.0",
    private: true,
    license: "Apache-2.0",
    dependencies: { [`${SCOPE}/shared`]: "workspace:*", zod: "catalog:" },
    devDependencies: { [`${SCOPE}/config`]: "workspace:*" },
  });
  mkdirSync(join(root, "capabilities/feature/audio/template"), { recursive: true });
  writeFileSync(join(root, "capabilities/feature/audio/template/.gitkeep"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface StampedManifest {
  version?: string;
  private?: boolean;
  publishConfig?: { access?: string; registry?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("prepare-publish smoke", () => {
  test("stamps every publishable manifest and resolves its deps", () => {
    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);

    const audio = readJson<StampedManifest>("capabilities/feature/audio/package.json");
    expect(audio.version).toBe("1.2.3");
    expect(audio.private).toBeUndefined();
    // The SAME tarball goes to every index, so no publishConfig.registry may pin it;
    // only the access level is stamped.
    expect(audio.publishConfig?.access).toBe("restricted");
    expect(audio.publishConfig?.registry).toBeUndefined();
    // workspace:* -> ^<version>, catalog: -> the root catalog range.
    expect(audio.dependencies?.[`${SCOPE}/shared`]).toBe("^1.2.3");
    expect(audio.dependencies?.zod).toBe("^4.1.13");
    expect(audio.devDependencies?.[`${SCOPE}/config`]).toBe("^1.2.3");

    // The capability manifest is stamped to the release version too, so the manifest that ships in
    // the tarball no longer disagrees at 0.0.0. Other fields (id, kind) survive the round-trip.
    const audioManifest = readJson<{ id?: string; kind?: string; version?: string }>(
      "capabilities/feature/audio/capability.json",
    );
    expect(audioManifest.version).toBe("1.2.3");
    expect(audioManifest.id).toBe("audio");
    expect(audioManifest.kind).toBe("feature");

    // The in-closure shared package was stamped too.
    const shared = readJson<StampedManifest>("packages/shared/package.json");
    expect(shared.version).toBe("1.2.3");
    expect(shared.private).toBeUndefined();

    // The build-only config package was skipped: its version is untouched.
    expect(readJson<StampedManifest>("packages/config/package.json").version).toBe("1.0.0");

    // The template-bearing capability got the bundled .templateignore.
    expect(
      readFileSync(join(root, "capabilities/feature/audio/.templateignore"), "utf8"),
    ).toContain("*.test.ts");
  });

  test("bundles the root LICENSE into the public packages and no others", () => {
    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);

    expect(readFileSync(join(root, "capabilities/feature/audio/LICENSE"), "utf8")).toContain(
      "Apache License",
    );
    // A private package grants nothing, so staging the Apache text beside it would offer terms
    // its declared `UNLICENSED` does not.
    expect(existsSync(join(root, "packages/shared/LICENSE"))).toBe(false);
    // SKIP_PUBLISH packages are never stamped, so they are never licensed either.
    expect(existsSync(join(root, "packages/config/LICENSE"))).toBe(false);
  });

  test("clears the staged LICENSE when a capability goes private", () => {
    expect(run("1.2.3").exitCode).toBe(0);
    expect(existsSync(join(root, "capabilities/feature/audio/LICENSE"))).toBe(true);

    writeJson("capabilities/feature/audio/capability.json", {
      id: "audio",
      version: "0.1.0",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/audio/package.json", {
      name: `${SCOPE}/feature-audio`,
      version: "0.0.0",
      private: true,
      license: "UNLICENSED",
    });

    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);
    // npm packs a package-root LICENSE whatever `files` says, so leaving the copy behind would ship
    // the Apache text inside a tarball that declares UNLICENSED.
    expect(existsSync(join(root, "capabilities/feature/audio/LICENSE"))).toBe(false);
  });

  const mismatches = [
    {
      case: "a public capability that grants nothing",
      expected: 'must declare "license": "Apache-2.0", got "UNLICENSED"',
      license: "UNLICENSED",
      path: "capabilities/feature/audio/package.json",
      name: `${SCOPE}/feature-audio`,
    },
    {
      case: "a public capability with no licence field at all",
      expected: 'must declare "license": "Apache-2.0", got null',
      license: undefined,
      path: "capabilities/feature/audio/package.json",
      name: `${SCOPE}/feature-audio`,
    },
    {
      case: "a private package offering Apache-2.0",
      expected: 'must declare "license": "UNLICENSED", got "Apache-2.0"',
      license: "Apache-2.0",
      path: "packages/shared/package.json",
      name: `${SCOPE}/shared`,
    },
  ];

  test.each(mismatches)("refuses to stamp $case", ({ expected, license, name, path }) => {
    writeJson(
      path,
      license
        ? { name, version: "0.0.0", private: true, license }
        : { name, version: "0.0.0", private: true },
    );

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain(expected);
    // The plan aborts before any write, so the other package is still at its authored version.
    expect(readJson<StampedManifest>("packages/config/package.json").version).toBe("1.0.0");
  });

  test("refuses to stamp anything when the repo has no root LICENSE", () => {
    rmSync(join(root, "LICENSE"));

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("published packages would carry no licence text");
    // The guard runs before the plan is applied, so no manifest was stamped.
    expect(readJson<StampedManifest>("capabilities/feature/audio/package.json").version).toBe(
      "0.0.0",
    );
  });

  test("discovers and stamps a capability root at its kind/id path", () => {
    // A second capability at its `<kind>/<id>` path. scanPackageManifests must recurse to reach it
    // and validate its name against the kind-qualified identity `feature/scoped`; a one-level
    // readdir would never see it, so its manifest would ship unstamped at 0.0.0.
    writeJson("capabilities/feature/scoped/capability.json", {
      id: "scoped",
      version: "0.1.0",
      kind: "feature",
      packages: ["ts"],
    });
    // No `metadata.public`, which is consumer-false, so it declares nothing granted.
    writeJson("capabilities/feature/scoped/package.json", {
      name: `${SCOPE}/feature-scoped`,
      version: "0.0.0",
      private: true,
      license: "UNLICENSED",
    });

    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);

    const scoped = readJson<StampedManifest>("capabilities/feature/scoped/package.json");
    expect(scoped.version).toBe("1.2.3");
    expect(scoped.private).toBeUndefined();
    expect(
      readJson<{ version?: string }>("capabilities/feature/scoped/capability.json").version,
    ).toBe("1.2.3");
  });

  // A candidate is one commit's worth of capabilities, published while the release it is a
  // candidate for does not exist yet -- but the release BEFORE it does. `^0.1.3-rc52309221` is
  // satisfied by the released 0.1.3 the moment it lands, and npm prefers it, so a caret would
  // quietly resolve a reviewer's RC install of `audio` to a released `shared`. Exact pins keep an
  // RC tree whole.
  test("a pre-release pins its siblings exactly, where a release carries a caret", () => {
    const res = run("0.1.3-rc52309221");
    expect(res.exitCode, res.output).toBe(0);

    const audio = readJson<StampedManifest>("capabilities/feature/audio/package.json");
    expect(audio.version).toBe("0.1.3-rc52309221");
    expect(audio.dependencies?.[`${SCOPE}/shared`]).toBe("0.1.3-rc52309221");
    expect(audio.devDependencies?.[`${SCOPE}/config`]).toBe("0.1.3-rc52309221");
    // A catalog: dep is a third-party range and has nothing to do with the release version.
    expect(audio.dependencies?.zod).toBe("^4.1.13");
  });

  test("fails loudly on a catalog: dep with no catalog entry, rather than shipping it unresolved", () => {
    writeJson("capabilities/feature/audio/package.json", {
      name: `${SCOPE}/feature-audio`,
      version: "0.0.0",
      private: true,
      license: "Apache-2.0",
      dependencies: { "some-lib": "catalog:" },
    });
    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("no catalog entry for some-lib");
  });

  test("fails when a descriptor capability has no valid, correctly named npm manifest", () => {
    rmSync(join(root, "capabilities/feature/audio/package.json"));
    let res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("must carry a valid package.json");

    writeFileSync(join(root, "capabilities/feature/audio/package.json"), "{not json\n");
    res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("must carry a valid package.json");

    writeJson("capabilities/feature/audio/package.json", { name: `${SCOPE}/wrong` });
    res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain(`expected package name '${SCOPE}/feature-audio'`);
  });

  test("rejects a shared package without a package name", () => {
    writeJson("packages/shared/package.json", { version: "0.0.0" });

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("package name is required");
  });

  test("rejects a shared package whose name collides with a capability, before stamping", () => {
    // A shared package that renders the same npm name as the capability `feature/audio`
    // (`@scope/feature-audio`) would silently fight over ownership. scanPackageManifests must
    // reject it before any package.json is stamped, naming the colliding name.
    writeJson("packages/feature-audio/package.json", {
      name: `${SCOPE}/feature-audio`,
      version: "0.3.0",
      private: true,
    });

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain(`npm package name '${SCOPE}/feature-audio' is rendered by more`);
    // No write landed: the capability manifest is still at its authored version.
    expect(readJson<StampedManifest>("capabilities/feature/audio/package.json").version).toBe(
      "0.0.0",
    );
  });

  test("stamps a template-only capability's manifest without requiring an npm package", () => {
    // A template-only capability declares `packages: []` and ships no package.json — it is
    // vendored through the descriptor's git source. Its capability.json must still be stamped to
    // the release version, or a consumer reads a 0.0.0 manifest that disagrees with the release.
    writeJson("capabilities/tooling/testing/capability.json", {
      id: "testing",
      version: "0.0.0",
      kind: "tooling",
      packages: [],
    });

    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);

    // The capability manifest was stamped, and no package.json was invented for it.
    const testingManifest = readJson<{ id?: string; version?: string }>(
      "capabilities/tooling/testing/capability.json",
    );
    expect(testingManifest.version).toBe("1.2.3");
    expect(testingManifest.id).toBe("testing");
    expect(existsSync(join(root, "capabilities/tooling/testing/package.json"))).toBe(false);

    // The ts-packaged sibling still stamped its npm package.
    expect(readJson<StampedManifest>("capabilities/feature/audio/package.json").version).toBe(
      "1.2.3",
    );
  });

  test("rejects a capability whose manifest omits the packages declaration", () => {
    // An accidental omission must not be silently treated as template-only: that would drop a
    // capability that should ship a package from the release. Require the field explicitly.
    writeJson("capabilities/tooling/testing/capability.json", {
      id: "testing",
      version: "0.0.0",
      kind: "tooling",
    });

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("must declare an explicit `packages` array");
  });
});
