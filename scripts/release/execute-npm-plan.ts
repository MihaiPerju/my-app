/**
 * execute-npm-plan.ts — shared execution for npm publication plans.
 *
 * Entry points supply registry-specific commands and duplicate classifiers;
 * this module owns iteration, optional existence checks, failure aggregation,
 * counters, and reporting.
 */

import { type CommandResult, type CommandRunner, runCommand } from "../shared/run-command";
import type { PlanEntry } from "./publish-plan";

export type { CommandResult, CommandRunner } from "../shared/run-command";

export interface NpmPlanLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type NpmPlanOperation = "publish" | "stage";

const OPERATION_LABELS = {
  publish: { completed: "Published" },
  stage: { completed: "Staged" },
} as const satisfies Record<NpmPlanOperation, { completed: string }>;

// Keep registry pressure bounded even when a dependency wave is large. Three overlaps enough CLI
// startup/network latency to retain the benefit of waves without assuming Gemfury or npmjs accepts
// an unbounded burst (the current plan has waves as large as nine packages).
const MAX_CONCURRENT_NPM_COMMANDS = 3;

export interface NpmPlanPreflight {
  command(entry: PlanEntry): readonly string[];
  isComplete(result: CommandResult, entry: PlanEntry): boolean;
  completeMessage(entry: PlanEntry): string;
}

export interface NpmPlanExecutionMode {
  operation: NpmPlanOperation;
  command(entry: PlanEntry): readonly string[];
  preflight?: NpmPlanPreflight;
  isDuplicate(output: string): boolean;
  duplicateMessage(entry: PlanEntry): string;
}

export interface NpmPlanSummary {
  succeeded: number;
  skipped: number;
}

/**
 * Execute one canonical npm plan completely. Entry points own command syntax and
 * registry-specific duplicate signals; iteration, process execution, counters,
 * aggregation, and the final summary remain identical for every publisher.
 */
export async function executeNpmPlan(
  entries: readonly PlanEntry[],
  mode: NpmPlanExecutionMode,
  run: CommandRunner = runCommand,
  logger: NpmPlanLogger = console,
): Promise<NpmPlanSummary> {
  const { completed } = OPERATION_LABELS[mode.operation];
  if (entries.length === 0) throw new Error(`npm ${mode.operation} plan is empty`);

  const failed: { identity: string; index: number }[] = [];
  let succeeded = 0;
  let skipped = 0;

  const groups = new Map<number, { entry: PlanEntry; index: number }[]>();
  entries.forEach((entry, index) => {
    const group = entry.publishGroup ?? index;
    if (!Number.isInteger(group) || group < 0) {
      throw new Error(`invalid publish group for ${entry.name}@${entry.version}: ${group}`);
    }
    const members = groups.get(group);
    if (members === undefined) groups.set(group, [{ entry, index }]);
    else members.push({ entry, index });
  });

  const executeEntry = async (entry: PlanEntry, index: number): Promise<void> => {
    const identity = `${entry.name}@${entry.version}`;

    if (mode.preflight !== undefined) {
      try {
        const inspected = await run(mode.preflight.command(entry));
        if (mode.preflight.isComplete(inspected, entry)) {
          logger.warn(mode.preflight.completeMessage(entry));
          skipped++;
          return;
        }
      } catch {
        // An unavailable lookup must not prevent the authoritative publish attempt.
      }
    }

    let result: CommandResult;
    try {
      result = await run(mode.command(entry));
    } catch (error) {
      logger.error(`FAILED ${identity}: ${error instanceof Error ? error.message : String(error)}`);
      failed.push({ identity, index });
      return;
    }

    if (result.exitCode === 0) {
      logger.log(`${completed} ${identity}`);
      succeeded++;
      return;
    }

    const output = `${result.stdout}${result.stderr}`;
    if (mode.isDuplicate(output)) {
      logger.warn(mode.duplicateMessage(entry));
      skipped++;
      return;
    }

    logger.error(
      `FAILED ${identity}: ${output.trim() || `${mode.operation} command exited ${result.exitCode}`}`,
    );
    failed.push({ identity, index });
  };

  // Groups preserve pack-all's dependency order; only packages in the same independent wave run
  // concurrently. Plans without groups retain their historical serial array order.
  const orderedGroups = [...groups].toSorted(([left], [right]) => left - right);
  for (const [, members] of orderedGroups) {
    for (let offset = 0; offset < members.length; offset += MAX_CONCURRENT_NPM_COMMANDS) {
      const batch = members.slice(offset, offset + MAX_CONCURRENT_NPM_COMMANDS);
      await Promise.all(batch.map(({ entry, index }) => executeEntry(entry, index)));
    }
  }

  if (failed.length > 0) {
    const identities = failed.toSorted((a, b) => a.index - b.index).map(({ identity }) => identity);
    throw new Error(
      `${failed.length} package(s) failed to ${mode.operation}: ${identities.join(", ")}`,
    );
  }

  logger.log(`${completed} ${succeeded} + skipped ${skipped} package(s).`);
  return { succeeded, skipped };
}
