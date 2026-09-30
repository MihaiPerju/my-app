/**
 * Every capability that ships code ships tests — with no opt-out to abuse.
 *
 * The registry has no per-capability test gate: `bun run test` only checks repo structure, and the
 * e2e runs a capability's tests only as a side effect of them landing in a generated app. So a
 * capability can ship with zero tests and nothing fails. This guard closes that — but the
 * requirement is DERIVED, not a settable flag (a boolean "exempt me" only invites "just flag it"):
 * a capability must ship a runner-collectable test in its `template/` or `package/` zone IFF it has
 * an executable surface — it ships Python, or real JS/TS code. It is deliberately NOT keyed off the
 * `packages` declaration: template-only capabilities may ship runnable code without publishing
 * a package. A capability with no code has nothing to unit-test and owes nothing here; its real
 * validation lives in registry-level tests plus the e2e boot. You qualify for "no test" only by
 * genuinely shipping no code.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { uniqueCapabilityId } from "../../../scripts/shared/capability-identity";
import {
  capabilityDir,
  capabilityLocalIds,
  identityOf,
  readJson,
  REGISTRY_ROOT,
  walk,
} from "../support/template-tree";
import { renderHbs } from "../support/selection";

// A file some runner would collect: `*.test.*` / `*.spec.*` for bun/vitest (ts, tsx, js, jsx and
// the m/c variants), and pytest's two default shapes (`test_*.py`, `*_test.py`) anchored to a path
// segment so a stray `manifest_test.py` in `src/` counts but `contest.py` does not.
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)(?:test_.+|.+_test)\.py)$/;

// Only the two zones a runner ever reaches: `template/` is vendored into an app (its tests run in
// the e2e's generated app) and `package/` is the published dist (its py suites run via the e2e's
// `run_capability_package_tests`, its ts suites via a `test` script). A test-shaped file anywhere
// else -- a `docs/` example, a scratch file -- is collected by nothing, so it must not read as
// coverage.
const testFilesIn = (id: string, ...segments: string[]): string[] =>
  walk(join(capabilityDir(id), ...segments)).filter((path) => TEST_FILE.test(path));

// The testing capability owns the root pytest configuration as a standalone static file. Its
// `testpaths` are globs (`packages/py/*/tests`), which pytest expands against the generated app.
const PYTEST_PATHS = readFileSync(join(capabilityDir("testing"), "template", "pytest.ini"), "utf8")
  .split("\n")
  .filter((line) => /^    \S/.test(line) && !line.trimStart().startsWith("#"))
  .map((line) => line.trim());
/** Whether `rel` sits under a `testpaths` entry, reading `*` as one path segment as pytest does. */
const underTestPath = (root: string, rel: string): boolean =>
  new RegExp(
    `^${root
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+")}(?:/|$)`,
  ).test(rel);
// `invoke test-agents` runs this path from its own project directory because its flat imports make
// it intentionally unsuitable for the root pytest invocation.
const DIRECTORY_SCOPED_TEST_PATHS = ["apps/worker/tests"];

const isRunnableTestScript = (value: string | undefined): value is string =>
  typeof value === "string" && /^\s*(?:bun\s+test|vitest|jest)(?:\s|$)/.test(value);

type PackageManifest = { scripts?: { test?: string } };

/** Read a workspace manifest by the path it has after all selected templates are overlaid. */
const readTemplateWorkspaceManifest = (workspace: string): PackageManifest | undefined => {
  const renderedPath = join(workspace, "package.json");
  const sources = capabilityLocalIds.flatMap((id) => {
    const path = join(capabilityDir(id), "template", renderedPath);
    return [path, `${path}.hbs`].filter(existsSync);
  });
  if (sources.length === 0) return undefined;
  if (sources.length > 1) {
    throw new Error(`multiple templates contribute ${renderedPath}: ${sources.join(", ")}`);
  }

  const source = sources[0]!;
  if (!source.endsWith(".hbs")) return readJson<PackageManifest>(source);
  const rendered = renderHbs(readFileSync(source, "utf8"), new Set(capabilityLocalIds)).replaceAll(
    "{{projectName}}",
    "test-app",
  );
  // SAFETY: PackageManifest is the narrow field projection read from a repo-owned package.json;
  // malformed JSON fails this test instead of granting coverage.
  return JSON.parse(rendered) as PackageManifest;
};

/** A vendored test file must land under a root the generated app's runners actually collect. */
const isCollectedTemplateTest = (id: string, path: string): boolean => {
  const rel = relative(join(capabilityDir(id), "template"), path);
  if (path.endsWith(".py")) {
    return [...PYTEST_PATHS, ...DIRECTORY_SCOPED_TEST_PATHS].some((root) =>
      underTestPath(root, rel),
    );
  }
  // The root runner uses `turbo test`, so a JS/TS test is collected only when its owning workspace
  // has a runnable test script. Resolve by generated-app path because one capability can contribute
  // tests to a workspace whose manifest comes from another, and that manifest may be a .hbs.
  const workspace = /^(apps\/[^/]+|packages\/ts\/[^/]+)\//.exec(rel)?.[1];
  return (
    workspace !== undefined &&
    isRunnableTestScript(readTemplateWorkspaceManifest(workspace)?.scripts?.test)
  );
};

// Runtime source. Python is always executable; for the JS/TS family (js, jsx, ts, tsx and their
// m/c variants) a `.d.ts`/`.d.mts`/`.d.cts` is types only, not code.
const isPython = (path: string): boolean => path.endsWith(".py");
const isRuntimeJsTs = (path: string): boolean =>
  /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path);

// Derived, not declared — this is what makes the requirement non-abusable: there is no flag, you owe
// a test only by shipping code. A capability has an executable surface if it ships Python anywhere,
// real JS/TS in its vendored `template/` (app and library code), or real JS/TS in its published
// `package/` beyond the lone `index.ts` entry stub that "declare `ts` for every capability" leaves
// even on a code-free infra capability.
const hasExecutableSurface = (id: string): boolean => {
  const capDir = capabilityDir(id);
  if (walk(capDir).some(isPython)) return true;
  if (walk(join(capDir, "template")).some(isRuntimeJsTs)) return true;
  return walk(join(capDir, "package")).some(
    (path) => isRuntimeJsTs(path) && !path.endsWith("/index.ts"),
  );
};

// The capability's workspace `test` script -- what `turbo test` (and so `bun run test`) invokes for
// its package/ts zone. Absent, the ts suite is collected by nothing.
const hasTestScript = (id: string): boolean => {
  const manifest = join(capabilityDir(id), "package.json");
  return (
    existsSync(manifest) &&
    isRunnableTestScript(readJson<{ scripts?: { test?: string } }>(manifest).scripts?.test)
  );
};

const shipsTests = (id: string): boolean => {
  const templateTests = testFilesIn(id, "template").filter((path) =>
    isCollectedTemplateTest(id, path),
  );
  const packagePyTests = testFilesIn(id, "package", "py", "tests");
  const packageTsTests = testFilesIn(id, "package", "ts");
  return (
    templateTests.length > 0 ||
    packagePyTests.length > 0 ||
    (packageTsTests.length > 0 && hasTestScript(id))
  );
};

// The e2e's `run_capability_package_tests` runs `package/py` suites only for the ids in its
// committed floor. That floor is enforced at runtime for REMOVAL (a discovered-but-unfloored id
// fails the e2e), but an ADDED suite would run unfloored and could later vanish silently -- and
// either way the only guard lives in the 20-minute e2e. The floor is a plain JSON manifest that the
// Python runner and this ~2s test both consume, so neither parses the other's source.
const e2ePackagePySuites = (): string[] =>
  readJson<string[]>(
    join(REGISTRY_ROOT, "scripts", "e2e", "capability-package-py-suites.json"),
  ).toSorted();

const shipsPackagePyTests = (id: string): boolean =>
  testFilesIn(id, "package", "py", "tests").some((path) => path.endsWith(".py"));

describe("capability test coverage", () => {
  test("the meta-guard rejects test-looking files and placeholder scripts runners never execute", () => {
    expect(
      isCollectedTemplateTest(
        "workflows",
        join(
          capabilityDir("workflows"),
          "template",
          ".agents",
          "skills",
          "example",
          "test_example.py",
        ),
      ),
    ).toBe(false);
    expect(isRunnableTestScript("echo tests pass")).toBe(false);
    expect(isRunnableTestScript("false && bun test")).toBe(false);
    expect(isRunnableTestScript("")).toBe(false);
    expect(isRunnableTestScript("bun test package/ts")).toBe(true);
  });

  test("template JS/TS tests count only when their owning workspace runs tests", () => {
    // `common` deliberately has no test script, so its copied test-shaped files are not coverage.
    expect(
      isCollectedTemplateTest(
        "tanstack-start",
        join(
          capabilityDir("tanstack-start"),
          "template",
          "packages",
          "ts",
          "common",
          "src",
          "utils",
          "arrays.test.ts",
        ),
      ),
    ).toBe(false);

    // The apps/web manifest is a .hbs contributed by `tanstack-start`; tests from another capability still
    // resolve that generated workspace and its runnable script.
    expect(
      isCollectedTemplateTest(
        "chat",
        join(
          capabilityDir("chat"),
          "template",
          "apps",
          "web",
          "src",
          "features",
          "chat",
          "api.test.ts",
        ),
      ),
    ).toBe(true);
  });

  test("every capability that ships code ships a test", () => {
    // The accident this exists to catch (it caught connectors and bucket). Fix a failure by adding
    // a test in the capability's `template/` or `package/` zone — there is no exemption to set. A
    // capability that legitimately ships no code is not listed here because it has nothing to
    // unit-test; its behavior is proven by the registry-level tests and the e2e boot instead.
    const untested = capabilityLocalIds.filter((id) => hasExecutableSurface(id) && !shipsTests(id));
    expect(untested, "these capabilities ship code but no runner-collectable test").toEqual([]);
  });

  test("a package/ts suite is wired to a test script that runs it", () => {
    // Presence is not execution: a `package/ts` test with no `test` script satisfies the coverage
    // guard above while `turbo test` collects nothing from it -- the exact state `idp` shipped in
    // before this work. Require the script wherever the ts suite exists.
    const unwired = capabilityLocalIds
      .filter((id) => testFilesIn(id, "package", "ts").length > 0 && !hasTestScript(id))
      .toSorted();
    expect(
      unwired,
      'these ship package/ts tests but define no "test" script, so nothing runs them',
    ).toEqual([]);
  });

  test("the e2e package/py floor lists exactly the capabilities shipping those suites", () => {
    // The e2e can only run a package/py suite it is told to expect; this pins that committed floor
    // to disk so adding or removing such a suite without updating the set fails here in ~2s rather
    // than running unfloored (or, worse, silently vanishing) until the 20-minute e2e.
    const registryId = readJson<{ id: string }>(join(REGISTRY_ROOT, "registry.config.json")).id;
    const onDisk = capabilityLocalIds
      .filter(shipsPackagePyTests)
      .map((id) => uniqueCapabilityId(registryId, identityOf(id)))
      .toSorted();
    // Guard the guard: an empty on-disk scan would make the equality vacuously pass, hiding a
    // broken detector. api/evals/idp/bucket/search ship these today.
    expect(onDisk.length, "found no package/py suites — the detector regressed").toBeGreaterThan(0);
    expect(
      e2ePackagePySuites(),
      "scripts/e2e/capability-package-py-suites.json is out of sync with the package/py/tests on disk",
    ).toEqual(onDisk);
  });
});
