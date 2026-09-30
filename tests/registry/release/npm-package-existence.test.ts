import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  missingOutputLine,
  missingPackages,
  packumentUrl,
  preflight,
  publicPlanNames,
  type PackageProbe,
} from "../../../scripts/release/npm-package-existence";
import { PUBLIC_PACKAGE_REGISTRY } from "../../../scripts/release/package-registries";
import type { PlanEntry } from "../../../scripts/release/publish-plan";

/** A probe answering from a fixed table, and the names it was asked about, in order. */
function stubProbe(statuses: Record<string, number>): PackageProbe & { asked: string[] } {
  const asked: string[] = [];
  const probe = async (name: string): Promise<number> => {
    asked.push(name);
    const status = statuses[name];
    if (status === undefined) throw new Error(`unexpected probe for ${name}`);
    return status;
  };
  return Object.assign(probe, { asked });
}

function entry(name: string): PlanEntry {
  return { name, version: "0.1.3", tarball: `${name}.tgz`, registry: PUBLIC_PACKAGE_REGISTRY };
}

describe("npm package existence", () => {
  test("a scoped name is escaped so the registry answers for the package, not a path", () => {
    expect(packumentUrl("@mistralai-capabilities/registry")).toBe(
      "https://registry.npmjs.org/@mistralai-capabilities%2Fregistry",
    );
    expect(packumentUrl("nx")).toBe("https://registry.npmjs.org/nx");
  });

  test.each([
    ["every package present", { a: 200, b: 200 }, []],
    ["one package missing", { a: 200, b: 404 }, ["b"]],
    ["every package missing", { a: 404, b: 404 }, ["a", "b"]],
  ] as const)("%s", async (_case, statuses, expected) => {
    const probe = stubProbe(statuses);

    expect(await missingPackages(["a", "b"], probe)).toEqual([...expected]);
    expect(probe.asked).toEqual(["a", "b"]);
  });

  // A rate limit or an outage read as "this package needs creating" would send the run on to the
  // job that publishes, so anything but a plain yes or no stops it.
  test.each([
    ["rate limited", 429],
    ["registry outage", 503],
    ["redirect", 301],
    ["unauthorised", 401],
  ] as const)(
    "%s fails the preflight rather than reporting a missing package",
    async (_case, status) => {
      await expect(missingPackages(["a"], stubProbe({ a: status }))).rejects.toThrow(
        `npmjs.org answered ${status} for a`,
      );
    },
  );

  test("a package staged under several entries is probed once", () => {
    expect(
      publicPlanNames([
        entry("@mistralai-capabilities/registry"),
        entry("@mistralai-capabilities/chat"),
        entry("@mistralai-capabilities/registry"),
      ]),
    ).toEqual(["@mistralai-capabilities/chat", "@mistralai-capabilities/registry"]);
  });

  // The bootstrap job keys off `missing != ''` and splits the value with `read -a`, so an empty
  // release and a two-package release have to be distinguishable from the line alone.
  test.each([
    ["nothing missing", [], "missing=\n"],
    ["one missing", ["@scope/a"], "missing=@scope/a\n"],
    ["two missing", ["@scope/a", "@scope/b"], "missing=@scope/a @scope/b\n"],
  ] as const)("the step output for %s", (_case, missing, line) => {
    expect(missingOutputLine([...missing])).toBe(line);
  });

  test.each([
    ["a release that creates no package", { "@scope/a": 200 }, []],
    ["a release whose first capability is new", { "@scope/a": 404 }, ["@scope/a"]],
  ] as const)("%s writes its answer to GITHUB_OUTPUT", async (_case, statuses, expected) => {
    const root = mkdtempSync(join(tmpdir(), "cap-preflight-"));
    const output = join(root, "github-output");
    try {
      await Bun.write(output, "");
      const missing = await preflight(["@scope/a"], stubProbe(statuses), output);

      expect(missing).toEqual([...expected]);
      expect(readFileSync(output, "utf8")).toBe(missingOutputLine([...expected]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a probe failure writes no output at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-preflight-"));
    const output = join(root, "github-output");
    try {
      await Bun.write(output, "");

      await expect(preflight(["@scope/a"], stubProbe({ "@scope/a": 503 }), output)).rejects.toThrow(
        "npmjs.org answered 503",
      );
      // A half-written output would let the bootstrap job read an empty `missing` and wave the
      // release through to a staging job that has nothing to stage against.
      expect(readFileSync(output, "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
