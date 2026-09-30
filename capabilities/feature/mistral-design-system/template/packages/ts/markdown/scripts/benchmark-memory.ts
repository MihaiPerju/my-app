import { createMarkdownSession, parseMarkdown } from "../src/index.js";
import {
  BENCHMARK_CASES,
  type BenchmarkCase,
  type BenchmarkMode,
} from "./benchmark-fixtures.js";

type MemoryBenchmarkResult = {
  readonly chunkCount?: number;
  readonly mode: BenchmarkMode;
  readonly name: string;
  readonly peakKiB: number;
  readonly retainedKiB: number;
};

const DEFAULT_SAMPLE_COUNT = 15;
const MEMORY_CASE_NAMES = [
  "long prose answer",
  "structured answer",
  "long prose answer - burst stream",
  "code reply - open fence stream",
  "long prose answer - late link tail",
  "math and prices answer - burst stream",
] as const;
let gcRoot: unknown;

function forceGc(): void {
  if (typeof globalThis.gc !== "function") {
    throw new Error(
      "Memory benchmarks require a GC-enabled runtime. Run with --expose-gc.",
    );
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    globalThis.gc();
  }
}

function heapUsedBytes(): number {
  return process.memoryUsage().heapUsed;
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

function median(values: readonly number[]): number {
  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  const middleValue = sortedValues[middleIndex];

  if (middleValue === undefined) {
    throw new Error("Cannot compute the median of an empty list.");
  }

  if (sortedValues.length % 2 === 1) {
    return middleValue;
  }

  const previousValue = sortedValues[middleIndex - 1];

  if (previousValue === undefined) {
    return middleValue;
  }

  return (previousValue + middleValue) / 2;
}

function measureMemoryCase(
  benchmarkCase: BenchmarkCase,
  sampleCount = DEFAULT_SAMPLE_COUNT,
): MemoryBenchmarkResult {
  const retainedSamples: number[] = [];
  const peakSamples: number[] = [];
  const chunks =
    benchmarkCase.mode === "streaming"
      ? (benchmarkCase.chunks ?? chunkSource(benchmarkCase.source))
      : undefined;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    forceGc();

    const beforeBytes = heapUsedBytes();
    let peakBytes = beforeBytes;

    if (benchmarkCase.mode === "full") {
      gcRoot = parseMarkdown(benchmarkCase.source);
      peakBytes = Math.max(peakBytes, heapUsedBytes());
    } else {
      const session = createMarkdownSession();
      let snapshot = session.parse("", false);
      let currentSource = "";

      for (const chunk of chunks ?? []) {
        currentSource += chunk;
        snapshot = session.parse(currentSource, false);
        peakBytes = Math.max(peakBytes, heapUsedBytes());
      }

      snapshot = session.parse(currentSource, true);
      peakBytes = Math.max(peakBytes, heapUsedBytes());
      gcRoot = {
        session,
        snapshot,
      };
    }

    forceGc();
    retainedSamples.push((heapUsedBytes() - beforeBytes) / 1024);
    peakSamples.push((peakBytes - beforeBytes) / 1024);
    void gcRoot;
    gcRoot = undefined;
    forceGc();
  }

  return {
    chunkCount: chunks?.length,
    mode: benchmarkCase.mode,
    name: benchmarkCase.name,
    peakKiB: median(peakSamples),
    retainedKiB: median(retainedSamples),
  };
}

function formatCaseLabel(result: MemoryBenchmarkResult): string {
  if (result.mode === "full") {
    return `full message parsing - ${result.name}`;
  }

  const chunkLabel =
    result.chunkCount === undefined ? "" : ` (${result.chunkCount} chunks)`;

  return `streaming session memory - ${result.name}${chunkLabel}`;
}

function formatValue(valueKiB: number): string {
  const sign = valueKiB >= 0 ? "" : "-";

  return `${sign}${Math.abs(valueKiB).toFixed(1)} KiB`;
}

function main(): void {
  const cases = BENCHMARK_CASES.filter((benchmarkCase) =>
    MEMORY_CASE_NAMES.includes(
      benchmarkCase.name as (typeof MEMORY_CASE_NAMES)[number],
    ),
  );
  const results = cases.map((benchmarkCase) =>
    measureMemoryCase(benchmarkCase),
  );
  let previousCaseLabel: string | undefined;

  console.log("Memory benchmark report (@mistral/markdown)");
  console.log("");

  for (const result of results) {
    const caseLabel = formatCaseLabel(result);

    if (caseLabel !== previousCaseLabel) {
      if (previousCaseLabel !== undefined) {
        console.log("");
      }

      console.log(caseLabel);
      previousCaseLabel = caseLabel;
    }

    console.log(
      `  retained ${formatValue(result.retainedKiB).padStart(12)}   peak ${formatValue(result.peakKiB).padStart(12)}`,
    );
  }
}

main();
