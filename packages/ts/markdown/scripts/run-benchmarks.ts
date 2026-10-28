import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transformFileAsync } from "@babel/core";
import { build } from "esbuild";

import {
  collectBenchmarkResults,
  collectTransformBenchmarkResults,
  formatBenchmarkResults,
  type BenchmarkResult,
} from "./benchmark-core.js";

type BenchmarkEngine = "all" | "hermes" | "node";

type HermesBenchmarkPayload = {
  readonly results: readonly BenchmarkResult[];
  readonly transformResults: readonly BenchmarkResult[];
};

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPO_ROOT = resolve(PACKAGE_DIRECTORY, "../../..");
const PNPM_DIRECTORY = resolve(REPO_ROOT, "node_modules/.pnpm");
const LE_CHAT_MOBILE_ANDROID_DIRECTORY = resolve(
  REPO_ROOT,
  "ts/apps/le-chat-mobile/android",
);
const require = createRequire(import.meta.url);
const transformClasses = require("@babel/plugin-transform-classes");
const transformClassProperties = require("@babel/plugin-transform-class-properties");

function parseRequestedEngine(argv: readonly string[]): BenchmarkEngine {
  const engineFlagIndex = argv.indexOf("--engine");

  if (engineFlagIndex === -1) {
    return "node";
  }

  const requestedEngine = argv[engineFlagIndex + 1];

  if (
    requestedEngine === "all" ||
    requestedEngine === "hermes" ||
    requestedEngine === "node"
  ) {
    return requestedEngine;
  }

  throw new Error(
    "Unsupported benchmark engine. Use --engine node, --engine hermes, or --engine all.",
  );
}

function printBenchmarkSection(
  title: string,
  results: readonly BenchmarkResult[],
): void {
  console.log(title);
  console.log("");

  for (const line of formatBenchmarkResults(results)) {
    console.log(line);
  }
}

function resolveHermesBinaryFromEnvironment(): string | null {
  const environmentPath = process.env.MISTRAL_MARKDOWN_HERMES_BIN;

  if (environmentPath === undefined || environmentPath.length === 0) {
    return null;
  }

  if (!existsSync(environmentPath)) {
    throw new Error(
      `MISTRAL_MARKDOWN_HERMES_BIN does not exist: ${environmentPath}`,
    );
  }

  return environmentPath;
}

function findReactNativePackageDirectory(): string | null {
  if (!existsSync(PNPM_DIRECTORY)) {
    return null;
  }

  for (const entry of readdirSync(PNPM_DIRECTORY)) {
    if (!entry.startsWith("@mistralai+react-native@")) {
      continue;
    }

    const packageDirectory = resolve(
      PNPM_DIRECTORY,
      entry,
      "node_modules/@mistralai/react-native",
    );

    if (existsSync(packageDirectory)) {
      return packageDirectory;
    }
  }

  return null;
}

function configureHermesBuildFromReactNativeGradle(): void {
  if (!existsSync(resolve(LE_CHAT_MOBILE_ANDROID_DIRECTORY, "gradlew"))) {
    throw new Error(
      [
        "Unable to configure the React Native Hermes build automatically.",
        "Set MISTRAL_MARKDOWN_HERMES_BIN to a host hermes binary built from the React Native Hermes source.",
      ].join(" "),
    );
  }

  const result = spawnSync(
    "./gradlew",
    [
      ":react-native:packages:react-native:ReactAndroid:hermes-engine:buildHermesC",
    ],
    {
      cwd: LE_CHAT_MOBILE_ANDROID_DIRECTORY,
      stdio: "inherit",
    },
  );

  if (result.status === 0) {
    return;
  }

  throw new Error("Failed to configure the React Native Hermes build.");
}

function buildHermesBinary(reactNativePackageDirectory: string): void {
  const buildDirectory = resolve(
    reactNativePackageDirectory,
    "ReactAndroid/hermes-engine/build/hermes",
  );

  if (!existsSync(buildDirectory)) {
    configureHermesBuildFromReactNativeGradle();
  }

  if (!existsSync(buildDirectory)) {
    throw new Error("React Native Hermes build directory is still missing.");
  }

  const parallelism = Math.max(1, Math.min(8, cpus().length));
  const result = spawnSync(
    "cmake",
    [
      "--build",
      buildDirectory,
      "--target",
      "hermes",
      "--parallel",
      String(parallelism),
    ],
    {
      stdio: "inherit",
    },
  );

  if (result.status === 0) {
    return;
  }

  throw new Error("Failed to build the local Hermes runtime.");
}

function resolveHermesBinary(): string {
  const environmentBinary = resolveHermesBinaryFromEnvironment();

  if (environmentBinary !== null) {
    return environmentBinary;
  }

  const reactNativePackageDirectory = findReactNativePackageDirectory();

  if (reactNativePackageDirectory === null) {
    throw new Error(
      [
        "Unable to locate @mistralai/react-native in the local pnpm store.",
        "Set MISTRAL_MARKDOWN_HERMES_BIN to a host hermes runtime if you want to use a downloaded binary.",
      ].join(" "),
    );
  }

  const hermesBinary = resolve(
    reactNativePackageDirectory,
    "ReactAndroid/hermes-engine/build/hermes/bin/hermes",
  );

  if (existsSync(hermesBinary)) {
    return hermesBinary;
  }

  buildHermesBinary(reactNativePackageDirectory);

  if (existsSync(hermesBinary)) {
    return hermesBinary;
  }

  throw new Error("Hermes binary is still missing after the local build step.");
}

async function bundleHermesRuntimeScript(): Promise<{
  readonly outputFile: string;
  readonly temporaryDirectory: string;
}> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "mistral-markdown-hermes-bench-"),
  );
  const outputFile = resolve(temporaryDirectory, "benchmark-runtime.js");

  await build({
    entryPoints: [resolve(SCRIPT_DIRECTORY, "benchmark-runtime.ts")],
    outfile: outputFile,
    bundle: true,
    conditions: ["react-native"],
    format: "iife",
    logLevel: "silent",
    platform: "browser",
    target: "es2016",
  });

  return {
    outputFile,
    temporaryDirectory,
  };
}

async function downlevelHermesRuntimeScript(outputFile: string): Promise<void> {
  const transformedFile = await transformFileAsync(outputFile, {
    configFile: false,
    babelrc: false,
    comments: false,
    compact: false,
    filename: outputFile,
    plugins: [transformClasses, transformClassProperties],
    sourceType: "script",
  });

  const transformedCode = transformedFile?.code;

  if (transformedCode === undefined || transformedCode === null) {
    throw new Error("Failed to downlevel the Hermes benchmark bundle.");
  }

  await writeFile(outputFile, transformedCode, "utf8");
}

async function collectHermesBenchmarkResults(): Promise<HermesBenchmarkPayload> {
  const { outputFile, temporaryDirectory } = await bundleHermesRuntimeScript();

  try {
    await downlevelHermesRuntimeScript(outputFile);

    const hermesBinary = resolveHermesBinary();
    const executionResult = spawnSync(hermesBinary, ["-w", outputFile], {
      encoding: "utf8",
    });

    if (executionResult.status !== 0) {
      const details =
        executionResult.stderr.trim() || executionResult.stdout.trim();

      throw new Error(
        details.length === 0
          ? "Hermes benchmark run failed."
          : `Hermes benchmark run failed: ${details}`,
      );
    }

    const payload = executionResult.stdout.trim();

    if (payload.length === 0) {
      throw new Error("Hermes benchmark run produced no output.");
    }

    const parsedPayload = JSON.parse(payload) as HermesBenchmarkPayload;

    return parsedPayload;
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

async function main(): Promise<void> {
  const requestedEngine = parseRequestedEngine(process.argv.slice(2));

  if (requestedEngine === "node" || requestedEngine === "all") {
    printBenchmarkSection(
      "Benchmark results (Node/V8)",
      collectBenchmarkResults(),
    );
    console.log("");
    printBenchmarkSection(
      "Unstable transform overhead (Node/V8)",
      collectTransformBenchmarkResults(),
    );
  }

  if (requestedEngine === "all") {
    console.log("");
  }

  if (requestedEngine === "hermes" || requestedEngine === "all") {
    const hermesPayload = await collectHermesBenchmarkResults();

    printBenchmarkSection("Benchmark results (Hermes)", hermesPayload.results);
    console.log("");
    printBenchmarkSection(
      "Unstable transform overhead (Hermes)",
      hermesPayload.transformResults,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unknown benchmark error.",
  );
  process.exitCode = 1;
});
