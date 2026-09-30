/**
 * shared/generated-files.ts — the freshness protocol every derived file in this repo follows:
 * `bun run registry:build` writes it, `bun run registry:check` (in `framework-check.yaml`)
 * fails on drift and prints the diff. One implementation, so a new generated target is a
 * `GeneratedFile` entry rather than another copy of the write/compare/diff dance.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import { $ } from "bun";

/**
 * A file derived from something else in the repo. `generate` is pure apart from reading its
 * own inputs, and throws rather than returning a wrong answer, so a caller can reuse it in a
 * test without inheriting the CLI's exit codes.
 */
export type GeneratedFile = {
  readonly path: string;
  readonly generate: () => string;
};

/**
 * Write every target, or in `check` mode report whether the committed copies already match.
 * Returns `false` when at least one is stale, having printed a unified diff for each; the
 * caller owns the exit code, and a throwing `generate` propagates.
 */
export async function syncGeneratedFiles(
  targets: readonly GeneratedFile[],
  check: boolean,
): Promise<boolean> {
  let fresh = true;

  for (const { path, generate } of targets) {
    const generated = generate();
    const label = relative(process.cwd(), path);

    if (!check) {
      writeFileSync(path, generated);
      console.log(`Wrote ${label}`);
      continue;
    }

    const committed = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (committed === generated) continue;

    fresh = false;
    console.error(`${label} is stale — run \`bun run registry:build\` and commit the result.\n`);
    // Writing the fresh copy to a temp file and shelling out to `diff` beats a bespoke differ.
    // The two are known to differ, so `diff`'s non-zero status is not the signal.
    const tmp = `${path}.expected`;
    writeFileSync(tmp, generated);
    try {
      await $`diff -u ${path} ${tmp}`.nothrow();
    } finally {
      await $`rm -f ${tmp}`.nothrow();
    }
  }

  return fresh;
}
