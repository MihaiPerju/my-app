/**
 * This repo resolves against the indexes it declares, and nothing else.
 *
 * A caching mirror is not a declared index. Resolving through it rewrites `uv.lock` provenance
 * (env vars outrank `[[tool.uv.index]]`), 403s the `.metadata` sidecar so resolution fails, and
 * its `UV_EXTRA_INDEX_URL` reopens dependency confusion. These tests hold the declared pair.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REGISTRY_ROOT } from "../support/template-tree";

const MIRROR_HOST = "socket-registry.mistralai.com";

const PYTHON_HOSTS = ["pypi.org", "files.pythonhosted.org", "pypi.fury.io"];
const NPM_HOSTS = ["registry.npmjs.org"];

/** Every host a lockfile resolves from. */
function hostsIn(file: string): string[] {
  const raw = readFileSync(join(REGISTRY_ROOT, file), "utf8");
  return [
    ...new Set([...raw.matchAll(/https?:\/\/([^/"'\s]+)/g)].map(([, host]) => host!)),
  ].toSorted();
}

describe("index provenance", () => {
  test("uv.lock resolves only from the declared Python indexes", () => {
    // Not a style rule: a proxied lock is a lock whose contents were chosen by an index this repo
    // never declared, and `bun run test` is the only thing that looks.
    expect(hostsIn("uv.lock").filter((host) => !PYTHON_HOSTS.includes(host))).toEqual([]);
  });

  test("bun.lock resolves only from the public npm registry", () => {
    expect(hostsIn("bun.lock").filter((host) => !NPM_HOSTS.includes(host))).toEqual([]);
  });
});

describe("the Socket mirror is absent", () => {
  test("no tracked file names the mirror", () => {
    // No tracked file may name the mirror host. Use `git grep` and check its exit status, which
    // distinguishes "no matches" (1) from an enumeration error (>1) -- a walk that ignored the
    // error would pass green on a failed scan.
    const scan = Bun.spawnSync(
      [
        "git",
        "grep",
        "--fixed-strings",
        "--files-with-matches",
        MIRROR_HOST,
        "--",
        ".",
        // This file necessarily names the host to search for it.
        ":!tests/registry/release/index-provenance.test.ts",
      ],
      { cwd: REGISTRY_ROOT },
    );
    if (scan.exitCode > 1) {
      throw new Error(
        `git grep failed (${scan.exitCode}): ${new TextDecoder().decode(scan.stderr)}`,
      );
    }
    const offenders =
      scan.exitCode === 0 ? new TextDecoder().decode(scan.stdout).split("\n").filter(Boolean) : [];
    expect(offenders).toEqual([]);
  });

  test("the e2e forces the declared indexes instead of inheriting them", () => {
    // Absence is not enough on its own: the e2e never NAMED the mirror, it inherited it from the
    // ambient environment — which is how the whole Python phase came to resolve through it.
    const e2e = readFileSync(join(REGISTRY_ROOT, "scripts", "e2e", "e2e_harness.py"), "utf8");
    expect(e2e).toContain('"UV_DEFAULT_INDEX": PUBLIC_PYPI');
    expect(e2e).toContain('"UV_EXTRA_INDEX_URL": ""');
  });
});
