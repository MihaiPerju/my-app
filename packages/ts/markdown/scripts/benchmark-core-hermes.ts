import { Parser as CommonMarkParser } from "commonmark";
import MarkdownIt from "markdown-it";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { createMarkdownSession, parseMarkdown } from "../src/index.js";
import {
  BENCHMARK_CASES,
  type BenchmarkCase,
  type BenchmarkMode,
} from "./benchmark-fixtures.js";
import {
  TRANSFORM_BENCHMARK_CHUNKS,
  TRANSFORM_BENCHMARK_SOURCE,
  TRANSFORM_BENCHMARK_VARIANTS,
} from "./benchmark-transform-cases.js";

export type BenchmarkResult = {
  readonly chunkCount?: number;
  readonly library: string;
  readonly mode: BenchmarkMode;
  readonly msPerIteration: number;
  readonly name: string;
};

function nowMilliseconds(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

function measureBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  runIteration: () => void,
): number {
  const warmupBatches = benchmarkCase.warmupBatches ?? 3;

  for (let warmupBatch = 0; warmupBatch < warmupBatches; warmupBatch += 1) {
    for (
      let iteration = 0;
      iteration < benchmarkCase.batchSize;
      iteration += 1
    ) {
      runIteration();
    }
  }

  const startedAt = nowMilliseconds();
  let elapsedMs = 0;
  let iterations = 0;

  while (elapsedMs < benchmarkCase.minTotalMs) {
    for (
      let iteration = 0;
      iteration < benchmarkCase.batchSize;
      iteration += 1
    ) {
      runIteration();
    }

    iterations += benchmarkCase.batchSize;
    elapsedMs = nowMilliseconds() - startedAt;
  }

  return elapsedMs / iterations;
}

function chunkSource(source: string): string[] {
  const chunks: string[] = [];
  let chunkStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") {
      continue;
    }

    chunks.push(source.slice(chunkStart, index + 1));
    chunkStart = index + 1;
  }

  if (chunkStart < source.length) {
    chunks.push(source.slice(chunkStart));
  }

  return chunks.length === 0 ? [source] : chunks;
}

function getBenchmarkChunks(benchmarkCase: BenchmarkCase): readonly string[] {
  return benchmarkCase.chunks ?? chunkSource(benchmarkCase.source);
}

export function collectHermesBenchmarkResults(): BenchmarkResult[] {
  const markdownIt = new MarkdownIt("commonmark");
  const commonMark = new CommonMarkParser();
  const remarkProcessor = remark().use(remarkGfm).use(remarkMath);
  const results: BenchmarkResult[] = [];

  for (const benchmarkCase of BENCHMARK_CASES) {
    if (benchmarkCase.mode === "full") {
      results.push({
        name: benchmarkCase.name,
        mode: benchmarkCase.mode,
        library: "@mistral/markdown",
        msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
          parseMarkdown(benchmarkCase.source);
        }),
      });
      results.push({
        name: benchmarkCase.name,
        mode: benchmarkCase.mode,
        library: "remark + gfm + math",
        msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
          remarkProcessor.parse(benchmarkCase.source);
        }),
      });
      results.push({
        name: benchmarkCase.name,
        mode: benchmarkCase.mode,
        library: "markdown-it",
        msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
          markdownIt.parse(benchmarkCase.source, {});
        }),
      });
      results.push({
        name: benchmarkCase.name,
        mode: benchmarkCase.mode,
        library: "commonmark.js",
        msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
          commonMark.parse(benchmarkCase.source);
        }),
      });

      continue;
    }

    const chunks = getBenchmarkChunks(benchmarkCase);

    results.push({
      name: benchmarkCase.name,
      mode: benchmarkCase.mode,
      chunkCount: chunks.length,
      library: "@mistral/markdown session",
      msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
        const session = createMarkdownSession();
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          session.parse(currentSource, false);
        }

        session.parse(currentSource, true);
      }),
    });
    results.push({
      name: benchmarkCase.name,
      mode: benchmarkCase.mode,
      chunkCount: chunks.length,
      library: "@mistral/markdown reparse",
      msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          parseMarkdown(currentSource);
        }
      }),
    });
    results.push({
      name: benchmarkCase.name,
      mode: benchmarkCase.mode,
      chunkCount: chunks.length,
      library: "remark + gfm + math reparse",
      msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          remarkProcessor.parse(currentSource);
        }
      }),
    });
    results.push({
      name: benchmarkCase.name,
      mode: benchmarkCase.mode,
      chunkCount: chunks.length,
      library: "markdown-it reparse",
      msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          markdownIt.parse(currentSource, {});
        }
      }),
    });
    results.push({
      name: benchmarkCase.name,
      mode: benchmarkCase.mode,
      chunkCount: chunks.length,
      library: "commonmark.js reparse",
      msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          commonMark.parse(currentSource);
        }
      }),
    });
  }

  return results;
}

export function collectHermesTransformBenchmarkResults(): BenchmarkResult[] {
  const benchmarkCase = {
    name: "projection fixture",
    mode: "full",
    source: TRANSFORM_BENCHMARK_SOURCE,
    batchSize: 3,
    minTotalMs: 200,
  } satisfies BenchmarkCase;
  const streamingBenchmarkCase = {
    name: "projection fixture - token stream",
    mode: "streaming",
    source: TRANSFORM_BENCHMARK_SOURCE,
    batchSize: 1,
    minTotalMs: 150,
    chunks: TRANSFORM_BENCHMARK_CHUNKS,
    warmupBatches: 1,
  } satisfies BenchmarkCase;
  const results: BenchmarkResult[] = [];

  for (const variant of TRANSFORM_BENCHMARK_VARIANTS) {
    results.push({
      name: benchmarkCase.name,
      mode: benchmarkCase.mode,
      library: `@mistral/markdown ${variant.label}`,
      msPerIteration: measureBenchmarkCase(benchmarkCase, () => {
        if (variant.unstable_transforms === undefined) {
          parseMarkdown(benchmarkCase.source);
          return;
        }

        parseMarkdown(benchmarkCase.source, {
          unstable_transforms: variant.unstable_transforms,
        });
      }),
    });
  }

  for (const variant of TRANSFORM_BENCHMARK_VARIANTS) {
    results.push({
      name: streamingBenchmarkCase.name,
      mode: streamingBenchmarkCase.mode,
      chunkCount: TRANSFORM_BENCHMARK_CHUNKS.length,
      library: `@mistral/markdown session ${variant.label}`,
      msPerIteration: measureBenchmarkCase(streamingBenchmarkCase, () => {
        const session =
          variant.unstable_transforms === undefined
            ? createMarkdownSession()
            : createMarkdownSession({
                unstable_transforms: variant.unstable_transforms,
              });
        let currentSource = "";

        for (const chunk of TRANSFORM_BENCHMARK_CHUNKS) {
          currentSource += chunk;
          session.parse(currentSource, false);
        }

        session.parse(currentSource, true);
      }),
    });
  }

  return results;
}
