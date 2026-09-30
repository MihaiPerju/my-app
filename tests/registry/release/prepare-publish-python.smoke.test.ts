/**
 * Smoke test for prepare-publish-python.ts: it builds a throwaway registry and runs the real script
 * as a subprocess, so actual fs behaviour runs rather than a stub.
 *
 * It covers the version stamp and the licence scope. Only a capability marked `metadata.public`
 * gets the repo-root LICENSE staged beside its pyproject; everything else grants nothing. Neither
 * half fails on its own at build time, which is why they are asserted here: `uv_build` skips a
 * `license-files` glob that matches nothing, and it will happily build a wheel declaring
 * `Apache-2.0` for code the repository never meant to licence.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REGISTRY_ROOT } from "../support/template-tree";

const SCRIPT = join(REGISTRY_ROOT, "scripts", "release", "prepare-publish-python.ts");

let root: string;

function writeFile(rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

/** Write a capability root with a Python zone, at its canonical `<kind>/<id>` path. */
function writeCapability(
  kind: string,
  id: string,
  isPublic: boolean,
  license = isPublic
    ? 'license = "Apache-2.0"\nlicense-files = ["LICENSE"]'
    : 'license = "LicenseRef-Proprietary"',
): void {
  writeFile(
    `capabilities/${kind}/${id}/capability.json`,
    JSON.stringify(
      { id, version: "0.1.0", kind, packages: ["py"], metadata: { public: isPublic } },
      null,
      2,
    ) + "\n",
  );
  writeFile(
    `capabilities/${kind}/${id}/package/py/pyproject.toml`,
    `[project]\nname = "mistralai-capabilities-${kind}-${id}"\nversion = "0.0.0"\n${license}\n\n[tool.uv]\npackage = true\n`,
  );
}

function run(...args: string[]) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

const pyproject = (kind: string, id: string): string =>
  readFileSync(join(root, `capabilities/${kind}/${id}/package/py/pyproject.toml`), "utf8");

const stagedLicense = (kind: string, id: string): boolean =>
  existsSync(join(root, `capabilities/${kind}/${id}/package/py/LICENSE`));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cap-prepare-py-"));
  writeFileSync(join(root, "LICENSE"), "Apache License\nVersion 2.0\n");
  writeCapability("feature", "audio", true);
  writeCapability("feature", "ledger", false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("prepare-publish-python smoke", () => {
  test("stamps every distribution to the release version", () => {
    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);

    expect(pyproject("feature", "audio")).toContain('version = "1.2.3"');
    expect(pyproject("feature", "ledger")).toContain('version = "1.2.3"');
  });

  test("stages the root LICENSE beside the public distribution only", () => {
    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);

    expect(
      readFileSync(join(root, "capabilities/feature/audio/package/py/LICENSE"), "utf8"),
    ).toContain("Apache License");
    expect(stagedLicense("feature", "ledger")).toBe(false);
  });

  test("clears the staged LICENSE when a capability goes private", () => {
    expect(run("1.2.3").exitCode).toBe(0);
    expect(stagedLicense("feature", "audio")).toBe(true);

    writeCapability("feature", "audio", false);

    const res = run("1.2.3");
    expect(res.exitCode, res.output).toBe(0);
    // The pyproject no longer points at it, so the copy would sit in the source tree unreferenced
    // and still land in the sdist.
    expect(stagedLicense("feature", "audio")).toBe(false);
  });

  const mismatches = [
    {
      case: "a public distribution that grants nothing",
      expected: 'public distribution must declare license = "Apache-2.0"',
      id: "audio",
      isPublic: true,
      license: 'license = "LicenseRef-Proprietary"',
    },
    {
      case: "a public distribution with no license-files entry",
      expected: 'public distribution must declare license-files = ["LICENSE"]',
      id: "audio",
      isPublic: true,
      license: 'license = "Apache-2.0"',
    },
    {
      case: "a private distribution offering Apache-2.0",
      expected: 'private distribution must declare license = "LicenseRef-Proprietary"',
      id: "ledger",
      isPublic: false,
      license: 'license = "Apache-2.0"\nlicense-files = ["LICENSE"]',
    },
    {
      case: "a private distribution pointing at licence text it will not get",
      expected: "private distribution must not declare license-files",
      id: "ledger",
      isPublic: false,
      license: 'license = "LicenseRef-Proprietary"\nlicense-files = ["LICENSE"]',
    },
  ];

  test.each(mismatches)("refuses to stamp $case", ({ expected, id, isPublic, license }) => {
    writeCapability("feature", id, isPublic, license);

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain(expected);
    // The plan aborts before any write, so nothing in the tree was stamped or licensed.
    expect(pyproject("feature", "audio")).toContain('version = "0.0.0"');
    expect(stagedLicense("feature", "audio")).toBe(false);
  });

  test("refuses to stamp anything when the repo has no root LICENSE", () => {
    rmSync(join(root, "LICENSE"));

    const res = run("1.2.3");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("published distributions would carry no licence text");
    expect(pyproject("feature", "audio")).toContain('version = "0.0.0"');
  });
});
