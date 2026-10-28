import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildSpecInventory,
  filterSpecExamples,
  formatSpecInventory,
  formatSpecRunReport,
  mistralSpecAdapter,
  parseSpecExamples,
  placeholderSpecAdapter,
  runSpecHarness,
} from "../src/spec-harness/index.js";

type CliOptions = {
  readonly adapter: "mistral" | "placeholder";
  readonly inventory: boolean;
  readonly json: boolean;
  readonly limit?: number;
  readonly onlyNumber?: number;
  readonly sectionPattern?: RegExp;
  readonly specPath: string;
  readonly suite: string;
};

function parsePositiveInteger(value: string, flagName: string): number {
  const parsedValue: number = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${flagName} expects a positive integer.`);
  }

  return parsedValue;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let adapter: CliOptions["adapter"] = "mistral";
  let inventory = false;
  let json = false;
  let limit: number | undefined;
  let onlyNumber: number | undefined;
  let sectionPattern: RegExp | undefined;
  let specPath: string | undefined;
  let suite = "commonmark";

  for (let index = 0; index < argv.length; index += 1) {
    const argument: string = argv[index] ?? "";

    switch (argument) {
      case "--":
        break;
      case "--inventory":
        inventory = true;
        break;
      case "--adapter":
        index += 1;
        adapter = (argv[index] ?? adapter) as CliOptions["adapter"];
        break;
      case "--json":
        json = true;
        break;
      case "--limit":
        index += 1;
        limit = parsePositiveInteger(argv[index] ?? "", "--limit");
        break;
      case "--number":
        index += 1;
        onlyNumber = parsePositiveInteger(argv[index] ?? "", "--number");
        break;
      case "--section":
        index += 1;
        sectionPattern = new RegExp(argv[index] ?? "", "iu");
        break;
      case "--spec-path":
        index += 1;
        specPath = argv[index];
        break;
      case "--suite":
        index += 1;
        suite = argv[index] ?? suite;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (specPath === undefined) {
    throw new Error("Missing required --spec-path argument.");
  }

  return {
    adapter,
    inventory,
    json,
    limit,
    onlyNumber,
    sectionPattern,
    specPath,
    suite,
  };
}

function printUsage(): void {
  console.log(`Usage: tsx scripts/run-spec-harness.ts --suite <name> --spec-path <path> [options]

Options:
  --adapter <name>      Adapter to run: mistral or placeholder (default: mistral)
  --inventory           Print suite inventory instead of executing the adapter
  --json                Emit JSON instead of human-readable text
  --limit <n>           Limit the number of examples
  --number <n>          Run or inspect only one example number
  --section <pattern>   Filter examples by section name using a case-insensitive regex
  --help                Show this help text`);
}

async function main(): Promise<void> {
  const options: CliOptions = parseArgs(process.argv.slice(2));
  const absoluteSpecPath: string = resolve(process.cwd(), options.specPath);
  const specText: string = await readFile(absoluteSpecPath, "utf8");

  const parsedExamples = parseSpecExamples(specText, {
    suite: options.suite,
    sourcePath: options.specPath,
  });
  const filteredExamples = filterSpecExamples(parsedExamples, {
    limit: options.limit,
    onlyNumber: options.onlyNumber,
    sectionPattern: options.sectionPattern,
  });

  if (options.inventory) {
    const inventory = buildSpecInventory(filteredExamples, options.suite);

    if (options.json) {
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }

    console.log(formatSpecInventory(inventory));
    return;
  }

  const report = await runSpecHarness(
    filteredExamples,
    options.adapter === "placeholder"
      ? placeholderSpecAdapter
      : mistralSpecAdapter,
    options.suite,
  );

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSpecRunReport(report));
  }

  if (report.counts.fail > 0 || report.counts.error > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message: string =
    error instanceof Error ? error.message : "Unknown spec harness error.";
  console.error(message);
  process.exitCode = 1;
});
