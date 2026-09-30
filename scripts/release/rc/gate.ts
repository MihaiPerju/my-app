#!/usr/bin/env bun
/**
 * rc-gate.ts — decide whether one commit has earned a release candidate.
 *
 * This is the authorization boundary of the candidate pipeline: it is what
 * stands between a pull request's code and a job holding this organisation's
 * publish credentials. Fork rejection, which workflows are required, which
 * conclusions count as green, and which run is a workflow's verdict when it has
 * several — that policy lives in `candidateGate`, a pure function with tests,
 * not in a YAML string. `publish-rc.yaml` gathers the facts and wires the
 * outputs; it decides nothing.
 *
 * Nothing here trusts the shapes it is handed. The event payload and the API
 * responses are read field by field and anything malformed is dropped, because
 * a field this gate silently reads as `undefined` is a field that could turn a
 * failure into a publish.
 *
 * Prints `key=value` lines for $GITHUB_OUTPUT, like `rc-version.ts`. Notices go
 * to stderr so they cannot be read as an output.
 *
 *   bun scripts/release/rc/gate.ts
 */

import {
  field,
  isJsonNumber,
  type JsonValue,
  paginate,
  requiredEnv,
  stringField,
} from "./github-rest";

/** One workflow run for the commit under consideration. */
export interface RunSummary {
  name: string;
  /** `queued`, `in_progress`, `completed`. */
  status: string;
  /** `success`, `failure`, `skipped`, … — null until completed. */
  conclusion: string | null;
  createdAt: string;
}

interface GateBase {
  /** `owner/name` of the repository the candidate would publish from. */
  repository: string;
  runs: readonly RunSummary[];
}

export type GateInput =
  | (GateBase & {
      invocation: "workflow_run";
      /** The run whose completion woke the gate. Every field is untrusted API input. */
      trigger: { event?: string; headRepository?: string };
    })
  | (GateBase & { invocation: "workflow_dispatch" });

export type GateVerdict = { ready: true; green: number } | { ready: false; reason: string };

/**
 * Both must exist for the commit and both must have concluded `success`.
 * Everything else that runs on a pull request merely has to not fail.
 */
export const REQUIRED_WORKFLOWS = ["Framework check", "Generated-app e2e"] as const;

/** Publishing must not gate on itself, and merging is not a test. */
export const IGNORED_WORKFLOWS = {
  "Publish RC": true,
  Publish: true,
  "Publish (core)": true,
  "Auto-merge PRs with MERGE NOW label": true,
} satisfies Record<string, true>;

/**
 * `skipped` and `neutral` are how a path-filtered scan reports "nothing here for
 * me", so they are not failures. They are not successes either: a REQUIRED
 * workflow has to say `success`, which is what keeps a `neutral` e2e — the
 * environment could not run the check — from publishing anything.
 */
export const ACCEPTED_CONCLUSIONS = {
  success: true,
  skipped: true,
  neutral: true,
} satisfies Record<string, true>;

/**
 * The verdict for one commit. A `false` is not a failure of this workflow: the
 * commit either never earns a candidate, or the run that finishes last comes
 * back here and gets a `true`.
 */
export function candidateGate(input: GateInput): GateVerdict {
  const { repository, runs } = input;
  if (input.invocation === "workflow_run") {
    const { trigger } = input;
    // Candidates exist to review pull requests. A push to a branch, a tag, a
    // schedule: not one.
    if (trigger.event !== "pull_request") {
      return {
        ready: false,
        reason: `triggered by '${trigger.event ?? "missing"}', not a pull request`,
      };
    }
    // A fork's code must never be built by a job that can reach this
    // repository's publish credentials.
    if (!trigger.headRepository) {
      return { ready: false, reason: "workflow run has no head repository identity" };
    }
    if (trigger.headRepository !== repository) {
      return { ready: false, reason: `fork pull request from ${trigger.headRepository}` };
    }
  }

  // One workflow can have several runs for a commit: a re-run, or a push and a
  // pull_request event that both matched. The most recent is its verdict.
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    if (Object.hasOwn(IGNORED_WORKFLOWS, run.name)) continue;
    const previous = latest.get(run.name);
    if (!previous || Date.parse(run.createdAt) >= Date.parse(previous.createdAt)) {
      latest.set(run.name, run);
    }
  }

  const failed = [...latest.values()].filter(
    (run) =>
      run.status === "completed" && !Object.hasOwn(ACCEPTED_CONCLUSIONS, run.conclusion ?? ""),
  );
  if (failed.length > 0) {
    const named = failed.map((run) => `${run.name} (${run.conclusion})`).join(", ");
    return { ready: false, reason: `not green: ${named}` };
  }

  const missing = REQUIRED_WORKFLOWS.filter((name) => !latest.has(name));
  const pending = [...latest.values()].filter((run) => run.status !== "completed");
  if (missing.length > 0 || pending.length > 0) {
    const waiting = [...missing, ...pending.map((run) => run.name)].join(", ");
    return { ready: false, reason: `still waiting on ${waiting}` };
  }

  const notGreen = REQUIRED_WORKFLOWS.filter((name) => latest.get(name)?.conclusion !== "success");
  if (notGreen.length > 0) {
    const named = notGreen.map((name) => `${name} (${latest.get(name)?.conclusion})`).join(", ");
    return { ready: false, reason: `required check not successful: ${named}` };
  }

  return { ready: true, green: latest.size };
}

/**
 * One API run object, or undefined when it is missing a field the gate reads.
 * Dropping a malformed run is safe in one direction only, and it is the safe
 * one: a run the gate cannot read is a run it cannot count as green.
 */
export function readRun(value: JsonValue | undefined): RunSummary | undefined {
  const name = stringField(value, "name");
  const status = stringField(value, "status");
  const createdAt = stringField(value, "created_at");
  if (name === undefined || status === undefined || createdAt === undefined) return undefined;
  return { name, status, conclusion: stringField(value, "conclusion") ?? null, createdAt };
}

async function main(): Promise<void> {
  const token = requiredEnv("GITHUB_TOKEN");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const invocation = requiredEnv("INVOCATION");
  if (invocation !== "workflow_run" && invocation !== "workflow_dispatch") {
    throw new Error(`unsupported invocation '${invocation}'`);
  }

  // The event payload, read from disk rather than interpolated into a shell
  // command: every field in it is caller-controlled.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event: JsonValue = eventPath ? await Bun.file(eventPath).json() : {};
  const run = field(event, "workflow_run");
  const triggerEvent = stringField(run, "event");

  const sha = stringField(run, "head_sha") || process.env.INPUT_SHA || requiredEnv("GITHUB_SHA");
  console.log(`sha=${sha}`);

  const runPages = await paginate(
    `/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
    token,
  );
  const runs: RunSummary[] = [];
  for (const page of runPages) {
    const list = field(page, "workflow_runs");
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const summary = readRun(entry);
      if (summary) runs.push(summary);
    }
  }

  const verdict = candidateGate(
    invocation === "workflow_run"
      ? {
          invocation,
          trigger: {
            event: triggerEvent,
            headRepository: stringField(field(run, "head_repository"), "full_name"),
          },
          repository,
          runs,
        }
      : { invocation, repository, runs },
  );

  if (!verdict.ready) {
    console.error(`::notice::no candidate for ${sha}: ${verdict.reason}`);
    console.log("ready=false");
    return;
  }
  console.error(`::notice::all ${verdict.green} workflow(s) green for ${sha}`);

  // The pull request to announce on, resolved by head commit rather than by
  // list order: a commit can belong to several open pull requests at once (a
  // stacked branch), and only the one this commit is the HEAD of is the one a
  // candidate for it belongs on. No pull request is not an error — the candidate
  // still publishes, it just has nowhere to be announced.
  const pullPages = await paginate(`/repos/${repository}/commits/${sha}/pulls`, token);
  const pull = pullPages
    .flatMap((page) => (Array.isArray(page) ? page : []))
    .find(
      (candidate) =>
        stringField(candidate, "state") === "open" &&
        stringField(field(candidate, "head"), "sha") === sha,
    );
  const number = field(pull, "number");
  if (isJsonNumber(number)) console.log(`pr=${number}`);
  else console.error(`::notice::no open pull request has ${sha} as its head — nowhere to announce`);

  console.log("ready=true");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
