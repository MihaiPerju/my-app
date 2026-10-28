import { createMarkdownSession, parseMarkdown } from "../src/index.js";
import { BENCHMARK_CASES } from "./benchmark-fixtures.js";

type ProfileMode = "full" | "reparse" | "session";

function parseMode(value: string | undefined): ProfileMode {
  switch (value) {
    case "full":
    case "reparse":
    case "session":
      return value;
    default:
      throw new Error("Expected mode: full, session, or reparse.");
  }
}

function parseIterations(value: string | undefined, mode: ProfileMode): number {
  if (value === undefined) {
    return mode === "full" ? 2_000 : 300;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Iterations must be a positive integer.");
  }

  return parsed;
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

function main(): void {
  const mode = parseMode(process.argv[2]);
  const iterations = parseIterations(process.argv[3], mode);
  const requestedCaseName = process.argv[4];
  const defaultCaseName =
    mode === "full" ? "structured answer" : "long prose answer - burst stream";
  const benchmarkMode = mode === "full" ? "full" : "streaming";
  const benchmarkCase = BENCHMARK_CASES.find(
    (entry) =>
      entry.mode === benchmarkMode &&
      entry.name === (requestedCaseName ?? defaultCaseName),
  );

  if (benchmarkCase === undefined) {
    throw new Error(
      `Missing benchmark case "${requestedCaseName ?? defaultCaseName}".`,
    );
  }

  const chunks = benchmarkCase.chunks ?? chunkSource(benchmarkCase.source);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    switch (mode) {
      case "full":
        parseMarkdown(benchmarkCase.source);
        break;
      case "session": {
        const session = createMarkdownSession();
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          session.parse(currentSource, false);
        }

        session.parse(currentSource, true);
        break;
      }
      case "reparse": {
        let currentSource = "";

        for (const chunk of chunks) {
          currentSource += chunk;
          parseMarkdown(currentSource);
        }

        break;
      }
    }
  }
}

main();
