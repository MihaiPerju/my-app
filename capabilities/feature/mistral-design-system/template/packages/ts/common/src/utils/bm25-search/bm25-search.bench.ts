import { bench, describe } from "vitest";

import {
  createBm25SearchIndex,
  type Bm25SearchDocument,
  type Bm25SearchField,
} from "./bm25-search.js";

type BenchmarkDocument = {
  id: number;
};

type BenchmarkSourceDocument = {
  id: number;
  category: string;
  noiseSeed: number;
};

const benchmarkSources = createBenchmarkSourceDocuments(10_000);
const benchmarkTextDocuments = createBenchmarkTextDocuments(benchmarkSources);
const benchmarkWeightedDocuments =
  createBenchmarkWeightedDocuments(benchmarkSources);
const toolSources = createToolSourceDocuments(10_000);
const repeatedToolDocuments = createRepeatedToolDocuments(toolSources);
const weightedToolDocuments = createWeightedToolDocuments(toolSources);
const benchmarkIndex = createBm25SearchIndex(benchmarkWeightedDocuments);
const benchmarkQuery = "slack message search";

describe("bm25-search", () => {
  bench("create 10k source records", () => {
    createBenchmarkSourceDocuments(10_000);
  });

  bench("create 10k text searchable documents", () => {
    createBenchmarkTextDocuments(benchmarkSources);
  });

  bench("create 10k weighted searchable documents", () => {
    createBenchmarkWeightedDocuments(benchmarkSources);
  });

  bench("create index for 10k prebuilt text documents", () => {
    createBm25SearchIndex(benchmarkTextDocuments);
  });

  bench("create index for 10k prebuilt weighted documents", () => {
    createBm25SearchIndex(benchmarkWeightedDocuments);
  });

  bench("create 10k weighted searchable documents and index", () => {
    createBm25SearchIndex(createBenchmarkWeightedDocuments(benchmarkSources));
  });

  bench("create index for 10k old repeated tool documents", () => {
    createBm25SearchIndex(repeatedToolDocuments);
  });

  bench("create index for 10k weighted tool documents", () => {
    createBm25SearchIndex(weightedToolDocuments);
  });

  bench("search 10k documents with inverted index", () => {
    benchmarkIndex.search({ query: benchmarkQuery, limit: 10 });
  });
});

function createBenchmarkSourceDocuments(
  count: number,
): BenchmarkSourceDocument[] {
  const categories = [
    "slack message search channels threads",
    "linear issue search roadmap project",
    "github code search repository pull request",
    "notion page search workspace wiki",
    "calendar event lookup meeting schedule",
  ];

  return Array.from({ length: count }, (_, index) => ({
    id: index,
    category: categories[index % categories.length] ?? "",
    noiseSeed: index,
  }));
}

function createBenchmarkTextDocuments(
  sources: readonly BenchmarkSourceDocument[],
): Bm25SearchDocument<BenchmarkDocument>[] {
  return sources.map((source) => {
    const noise = Array.from(
      { length: 12 },
      (_unused, noiseIndex) => `token${(source.noiseSeed + noiseIndex) % 997}`,
    ).join(" ");

    return {
      document: { id: source.id },
      text: `${source.category} ${noise} documentNumber${source.id}`,
    };
  });
}

function createBenchmarkWeightedDocuments(
  sources: readonly BenchmarkSourceDocument[],
): Bm25SearchDocument<BenchmarkDocument>[] {
  return sources.map((source) => ({
    document: { id: source.id },
    fields: createBenchmarkFields(source),
  }));
}

function createBenchmarkFields(
  source: BenchmarkSourceDocument,
): Bm25SearchField[] {
  return [
    { text: source.category, weight: 2 },
    {
      text: Array.from(
        { length: 12 },
        (_unused, noiseIndex) =>
          `token${(source.noiseSeed + noiseIndex) % 997}`,
      ).join(" "),
    },
    { text: `documentNumber${source.id}` },
  ];
}

type ToolSourceDocument = {
  id: number;
  functionName: string;
  originalToolName: string;
  integrationName: string;
  toolDescription: string;
  integrationDescription: string;
  declaration: string;
};

function createToolSourceDocuments(count: number): ToolSourceDocument[] {
  const integrations = ["slack", "linear", "github", "notion", "calendar"];
  const operations = ["search", "list", "read", "lookup", "fetch"];

  return Array.from({ length: count }, (_, index) => {
    const integrationName = integrations[index % integrations.length] ?? "tool";
    const operation = operations[index % operations.length] ?? "search";
    const functionName = `${integrationName}${operation}Tool${index}`;

    return {
      id: index,
      functionName,
      originalToolName: `${integrationName}_${operation}_tool_${index}`,
      integrationName,
      toolDescription: `${operation} ${integrationName} workspace records and return concise metadata`,
      integrationDescription: `${integrationName} integration for internal work and knowledge retrieval`,
      declaration: `declare async function ${functionName}(input: { query: string; limit?: number }): Promise<{ results: Array<{ id: string; title: string; text: string }> }>;`,
    };
  });
}

function createRepeatedToolDocuments(
  sources: readonly ToolSourceDocument[],
): Bm25SearchDocument<ToolSourceDocument>[] {
  return sources.map((source) => ({
    document: source,
    text: [
      source.functionName,
      source.functionName,
      source.originalToolName,
      source.originalToolName,
      source.integrationName,
      source.toolDescription,
      source.toolDescription,
      source.integrationDescription,
      source.declaration,
    ].join("\n"),
  }));
}

function createWeightedToolDocuments(
  sources: readonly ToolSourceDocument[],
): Bm25SearchDocument<ToolSourceDocument>[] {
  return sources.map((source) => ({
    document: source,
    fields: [
      { text: source.functionName, weight: 2 },
      { text: source.originalToolName, weight: 2 },
      { text: source.integrationName },
      { text: source.toolDescription, weight: 2 },
      { text: source.integrationDescription },
      { text: source.declaration },
    ],
  }));
}
