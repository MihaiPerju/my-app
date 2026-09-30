import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  mistralSpecAdapter,
  parseSpecExamples,
  runSpecHarness,
} from "../../src/spec-harness/index.ts";

const officialSpecSuites = [
  {
    suite: "commonmark",
    sourcePath: "tests/spec-harness/corpus/commonmark-spec.txt",
    totalExamples: 655,
  },
  {
    suite: "gfm-extensions",
    sourcePath: "tests/spec-harness/corpus/gfm-extensions.txt",
    totalExamples: 30,
  },
  {
    suite: "gfm",
    sourcePath: "tests/spec-harness/corpus/gfm-spec.txt",
    totalExamples: 672,
  },
] as const;

describe("official spec corpus", () => {
  it.each(officialSpecSuites)(
    "keeps $suite compliance free of failures and local scratch dependencies",
    async ({ sourcePath, suite, totalExamples }) => {
      const specText = await readFile(
        fileURLToPath(new URL(`../../${sourcePath}`, import.meta.url)),
        "utf8",
      );
      const examples = parseSpecExamples(specText, {
        suite,
        sourcePath,
      });
      const report = await runSpecHarness(examples, mistralSpecAdapter, suite);

      expect(report.totalExamples).toBe(totalExamples);
      expect(report.counts.fail).toBe(0);
      expect(report.counts.error).toBe(0);
      expect(report.counts.notImplemented).toBe(0);
      expect(report.counts.pass + report.counts.skip).toBe(totalExamples);
    },
  );
});
