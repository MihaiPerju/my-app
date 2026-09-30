import { readFileSync } from "node:fs";

import type { BenchmarkResult } from "./benchmark-core.js";

type CaseComparison = {
  readonly afterMs: number;
  readonly beforeMs: number;
  readonly name: string;
  readonly speedup: number;
  readonly timeChangePercent: number;
};

type BenchmarkResultsFile = {
  readonly results: readonly BenchmarkResult[];
};

const REAL_WORLD_STREAMING_CASES = [
  "real-world table-heavy reply - token stream",
  "real-world html code reply - token stream",
  "real-world math html reply - token stream",
  "real-world mixed reply - token stream",
] as const;
const FULL_PARSE_CASES = ["real-world assistant corpus"] as const;

function isBenchmarkResultArray(
  value: unknown,
): value is readonly BenchmarkResult[] {
  return Array.isArray(value);
}

function isBenchmarkResultsFile(value: unknown): value is BenchmarkResultsFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "results" in value &&
    isBenchmarkResultArray(value.results)
  );
}

function readResults(path: string): readonly BenchmarkResult[] {
  const content = readFileSync(path, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return parseTextBenchmarkResults(content);
  }

  if (isBenchmarkResultArray(parsed)) {
    return parsed;
  }

  if (isBenchmarkResultsFile(parsed)) {
    return parsed.results;
  }

  throw new Error("Unsupported benchmark JSON format.");
}

function parseTextBenchmarkResults(
  content: string,
): readonly BenchmarkResult[] {
  const results: BenchmarkResult[] = [];
  let currentCase:
    | {
        readonly mode: BenchmarkResult["mode"];
        readonly name: string;
      }
    | undefined;

  for (const line of content.split("\n")) {
    if (line.startsWith("full message parsing - ")) {
      currentCase = {
        mode: "full",
        name: line.slice("full message parsing - ".length),
      };
      continue;
    }

    if (line.startsWith("streaming session total cpu - ")) {
      currentCase = {
        mode: "streaming",
        name: line
          .slice("streaming session total cpu - ".length)
          .replace(/ \(\d+ chunks\)$/u, ""),
      };
      continue;
    }

    const match =
      /^ {2}(?<library>.+?)\s+(?<value>\d+(?:\.\d+)?) ms\/(?<unit>parse|session)$/u.exec(
        line,
      );

    const library = match?.groups?.library;
    const value = match?.groups?.value;

    if (
      library === undefined ||
      value === undefined ||
      currentCase === undefined
    ) {
      continue;
    }

    results.push({
      library: library.trim(),
      mode: currentCase.mode,
      msPerIteration: Number(value),
      name: currentCase.name,
    });
  }

  return results;
}

function findResult(
  results: readonly BenchmarkResult[],
  name: string,
  library: string,
): BenchmarkResult {
  const result = results.find(
    (candidate) => candidate.name === name && candidate.library === library,
  );

  if (result === undefined) {
    throw new Error(`Missing benchmark result: ${library} / ${name}`);
  }

  return result;
}

function compareCases(
  before: readonly BenchmarkResult[],
  after: readonly BenchmarkResult[],
  caseNames: readonly string[],
  library: string,
): CaseComparison[] {
  return caseNames.map((name) => {
    const beforeMs = findResult(before, name, library).msPerIteration;
    const afterMs = findResult(after, name, library).msPerIteration;
    const speedup = beforeMs / afterMs;

    return {
      afterMs,
      beforeMs,
      name,
      speedup,
      timeChangePercent: ((afterMs - beforeMs) / beforeMs) * 100,
    };
  });
}

function geometricMean(values: readonly number[]): number {
  return Math.exp(
    values.reduce((sum, value) => sum + Math.log(value), 0) / values.length,
  );
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function printScore(
  title: string,
  comparisons: readonly CaseComparison[],
): void {
  const speedup = geometricMean(
    comparisons.map((comparison) => comparison.speedup),
  );
  const worst = comparisons.reduce((currentWorst, comparison) =>
    comparison.speedup < currentWorst.speedup ? comparison : currentWorst,
  );
  const regressions = comparisons.filter(
    (comparison) => comparison.timeChangePercent > 5,
  );

  console.log(
    `${title}: ${speedup.toFixed(2)}x throughput (${formatPercent((speedup - 1) * 100)})`,
  );
  console.log(
    `  worst case: ${worst.name}, ${worst.speedup.toFixed(2)}x throughput, ${formatPercent(worst.timeChangePercent)} time`,
  );
  console.log(`  regressions >5%: ${regressions.length}/${comparisons.length}`);

  for (const comparison of comparisons) {
    console.log(
      `  ${comparison.name}: ${comparison.beforeMs.toFixed(3)} -> ${comparison.afterMs.toFixed(3)} ms (${comparison.speedup.toFixed(2)}x, ${formatPercent(comparison.timeChangePercent)} time)`,
    );
  }
}

const [beforePath, afterPath] = process.argv.slice(2);

if (beforePath === undefined || afterPath === undefined) {
  throw new Error(
    "Usage: tsx scripts/compare-benchmarks.ts <before.json> <after.json>",
  );
}

const before = readResults(beforePath);
const after = readResults(afterPath);

printScore(
  "Real-world streaming score",
  compareCases(
    before,
    after,
    REAL_WORLD_STREAMING_CASES,
    "@mistral/markdown session",
  ),
);
console.log("");
printScore(
  "Full parse score",
  compareCases(before, after, FULL_PARSE_CASES, "@mistral/markdown"),
);
