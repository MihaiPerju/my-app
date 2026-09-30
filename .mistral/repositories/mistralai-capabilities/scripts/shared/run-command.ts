/**
 * Run a subprocess without a shell and capture its complete output.
 *
 * Callers that need inherited stdio or streaming output should use `spawn`
 * directly; this helper is the canonical path for captured command results.
 */

import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: readonly string[]) => Promise<CommandResult>;

export async function runCommand(command: readonly string[]): Promise<CommandResult> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error("cannot run an empty command");

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
