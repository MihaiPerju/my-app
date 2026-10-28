import type {
  SpecAdapter,
  SpecCaseResult,
  SpecExample,
  SpecFilterOptions,
  SpecInventory,
  SpecInventorySection,
  SpecRunCounts,
  SpecRunReport,
} from "./types.js";

function createEmptyCounts(): SpecRunCounts {
  return {
    pass: 0,
    fail: 0,
    notImplemented: 0,
    error: 0,
    skip: 0,
  };
}

export function filterSpecExamples(
  examples: readonly SpecExample[],
  options: SpecFilterOptions = {},
): SpecExample[] {
  let filteredExamples: SpecExample[] = [...examples];

  if (options.onlyNumber !== undefined) {
    filteredExamples = filteredExamples.filter(
      (example: SpecExample) => example.number === options.onlyNumber,
    );
  }

  if (options.sectionPattern !== undefined) {
    filteredExamples = filteredExamples.filter((example: SpecExample) =>
      options.sectionPattern?.test(example.section),
    );
  }

  if (options.limit !== undefined) {
    filteredExamples = filteredExamples.slice(0, options.limit);
  }

  return filteredExamples;
}

export function buildSpecInventory(
  examples: readonly SpecExample[],
  suite: string,
): SpecInventory {
  const sectionCounts: Map<string, number> = new Map<string, number>();
  const extensionNames: Set<string> = new Set<string>();

  for (const example of examples) {
    sectionCounts.set(
      example.section,
      (sectionCounts.get(example.section) ?? 0) + 1,
    );

    for (const extensionName of example.extensions) {
      extensionNames.add(extensionName);
    }
  }

  const sections: SpecInventorySection[] = [...sectionCounts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(
      ([section, exampleCount]: [string, number]): SpecInventorySection => ({
        section,
        exampleCount,
      }),
    );

  return {
    suite,
    totalExamples: examples.length,
    totalSections: sections.length,
    sections,
    extensions: [...extensionNames].sort(),
  };
}

export const placeholderSpecAdapter: SpecAdapter = {
  name: "placeholder",
  evaluate(): { status: "not_implemented"; message: string } {
    return {
      status: "not_implemented",
      message: "Parser execution is not wired into the spec harness yet.",
    };
  },
};

export async function runSpecHarness(
  examples: readonly SpecExample[],
  adapter: SpecAdapter,
  suite: string,
): Promise<SpecRunReport> {
  const counts: SpecRunCounts = createEmptyCounts();
  const results: SpecCaseResult[] = [];

  for (const example of examples) {
    try {
      const evaluation = await adapter.evaluate(example);

      results.push({
        example,
        evaluation,
      });

      switch (evaluation.status) {
        case "pass":
          counts.pass += 1;
          break;
        case "fail":
          counts.fail += 1;
          break;
        case "not_implemented":
          counts.notImplemented += 1;
          break;
        case "error":
          counts.error += 1;
          break;
        case "skip":
          counts.skip += 1;
          break;
      }
    } catch (error: unknown) {
      counts.error += 1;
      results.push({
        example,
        evaluation: {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unknown spec harness error.",
        },
      });
    }
  }

  const implementedExamples: number = counts.pass + counts.fail + counts.error;
  const passRate: number =
    examples.length === 0 ? 0 : counts.pass / examples.length;
  const implementedRate: number =
    examples.length === 0 ? 0 : implementedExamples / examples.length;

  return {
    suite,
    adapterName: adapter.name,
    totalExamples: examples.length,
    implementedExamples,
    passRate,
    implementedRate,
    counts,
    results,
  };
}

export function formatSpecInventory(inventory: SpecInventory): string {
  const lines: string[] = [
    `Suite: ${inventory.suite}`,
    `Examples: ${inventory.totalExamples}`,
    `Sections: ${inventory.totalSections}`,
  ];

  if (inventory.extensions.length > 0) {
    lines.push(`Extensions: ${inventory.extensions.join(", ")}`);
  }

  for (const section of inventory.sections) {
    lines.push(`- ${section.section}: ${section.exampleCount}`);
  }

  return lines.join("\n");
}

export function formatSpecRunReport(report: SpecRunReport): string {
  const lines: string[] = [
    `Suite: ${report.suite}`,
    `Adapter: ${report.adapterName}`,
    `Examples: ${report.totalExamples}`,
    `${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts.notImplemented} not implemented, ${report.counts.error} errored, ${report.counts.skip} skipped`,
    `Pass rate: ${(report.passRate * 100).toFixed(2)}%`,
    `Implemented rate: ${(report.implementedRate * 100).toFixed(2)}%`,
  ];

  return lines.join("\n");
}
