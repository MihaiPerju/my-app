/**
 * Behavioural tests for the release-candidate gate and its announcement.
 *
 * `candidateGate` is the authorization boundary of the candidate pipeline: a
 * `true` from it builds a pull request's code in a job that can reach this
 * organisation's publish credentials. Every way it can wrongly say `true` is
 * covered here — a fork, a failure, a check that has not finished, a required
 * workflow that never ran, a stale re-run — because the failure mode is silent:
 * a wrong `true` publishes and nothing goes red.
 */
import { describe, expect, test } from "bun:test";

import { findAnnouncement, MARKER, renderAnnouncement } from "../../../scripts/release/rc/announce";
import { candidateGate, readRun, type RunSummary } from "../../../scripts/release/rc/gate";

const HERE = "mistralai/mistralai-capabilities";

/** A completed run, `success` unless told otherwise. */
const run = (
  name: string,
  conclusion: string | null = "success",
  status = "completed",
): RunSummary => ({
  name,
  status,
  conclusion,
  createdAt: "2026-08-28T14:00:00Z",
});

/** The minimum set that makes a commit green. */
const GREEN = [run("Framework check"), run("Generated-app e2e")];

const gate = (
  runs: RunSummary[],
  trigger: { event?: string; headRepository?: string } = {
    event: "pull_request",
    headRepository: HERE,
  },
) => candidateGate({ invocation: "workflow_run", trigger, repository: HERE, runs });

describe("candidate gate", () => {
  test("both required workflows green is a candidate", () => {
    expect(gate(GREEN)).toEqual({ ready: true, green: 2 });
  });

  // The one that must never regress: a fork's code being built by a job that
  // holds the publish credentials.
  test("a fork pull request never publishes", () => {
    const verdict = gate(GREEN, { event: "pull_request", headRepository: "attacker/fork" });
    expect(verdict).toEqual({ ready: false, reason: "fork pull request from attacker/fork" });
  });

  test("a workflow run with no repository identity never publishes", () => {
    expect(gate(GREEN, { event: "pull_request" })).toEqual({
      ready: false,
      reason: "workflow run has no head repository identity",
    });
  });

  test("a workflow run with no event is not mistaken for a manual dispatch", () => {
    expect(gate(GREEN, { headRepository: HERE })).toEqual({
      ready: false,
      reason: "triggered by 'missing', not a pull request",
    });
  });

  test("only a pull request earns a candidate", () => {
    for (const event of ["push", "schedule", "release"]) {
      expect(gate(GREEN, { event, headRepository: HERE }).ready, event).toBe(false);
    }
  });

  test("a required workflow that has not run yet is a wait, not a candidate", () => {
    expect(gate([run("Framework check")])).toEqual({
      ready: false,
      reason: "still waiting on Generated-app e2e",
    });
  });

  test("a required workflow still running is a wait", () => {
    const verdict = gate([run("Framework check"), run("Generated-app e2e", null, "in_progress")]);
    expect(verdict).toEqual({ ready: false, reason: "still waiting on Generated-app e2e" });
  });

  test("any workflow that failed blocks the candidate, required or not", () => {
    expect(gate([...GREEN, run("Solutions Code Review", "failure")])).toEqual({
      ready: false,
      reason: "not green: Solutions Code Review (failure)",
    });
    expect(gate([run("Framework check", "failure"), run("Generated-app e2e")]).ready).toBe(false);
    expect(gate([...GREEN, run("Python vulnerability scan", "timed_out")]).ready).toBe(false);
  });

  // A path-filtered scan reporting "nothing here for me" is not a failure. It is
  // not a success either, which is what the next test pins down.
  test("a skipped non-required workflow does not block", () => {
    expect(gate([...GREEN, run("Python bandit", "skipped")]).ready).toBe(true);
  });

  // `generated-app-e2e.yaml` exits neutral when the CLI, the network or the
  // token failed. That is "the check did not run", so it must not publish -- the
  // exact case a `skipped`-is-fine rule would wave through if it applied to the
  // required set too.
  test("a neutral required workflow is not a success", () => {
    expect(gate([run("Framework check"), run("Generated-app e2e", "neutral")])).toEqual({
      ready: false,
      reason: "required check not successful: Generated-app e2e (neutral)",
    });
  });

  test("publishing does not gate on itself", () => {
    // Without the ignore list, the in-progress Publish RC run that is asking the
    // question would report itself as pending and no commit could ever publish.
    expect(gate([...GREEN, run("Publish RC", null, "in_progress")]).ready).toBe(true);
    expect(gate([...GREEN, run("Auto-merge PRs with MERGE NOW label", "cancelled")]).ready).toBe(
      true,
    );
  });

  // A re-run of a failed check is the whole point of re-running it.
  test("the most recent run is a workflow's verdict, not the first one seen", () => {
    const failedFirst: RunSummary = {
      name: "Framework check",
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-28T13:00:00Z",
    };
    const passedLater: RunSummary = {
      name: "Framework check",
      status: "completed",
      conclusion: "success",
      createdAt: "2026-08-28T15:00:00Z",
    };
    expect(gate([failedFirst, passedLater, run("Generated-app e2e")]).ready).toBe(true);
    // And the other way round: a re-run that broke it blocks the candidate.
    expect(
      gate([passedLater, { ...failedFirst, createdAt: "2026-08-28T16:00:00Z" }, GREEN[1]!]).ready,
    ).toBe(false);
  });

  test("a manual dispatch skips the trigger checks but not the green ones", () => {
    expect(
      candidateGate({ invocation: "workflow_dispatch", repository: HERE, runs: GREEN }),
    ).toEqual({
      ready: true,
      green: 2,
    });
    expect(
      candidateGate({
        invocation: "workflow_dispatch",
        repository: HERE,
        runs: [run("Framework check")],
      }).ready,
    ).toBe(false);
  });
});

describe("gate input parsing", () => {
  // A run object the gate cannot read is a run it cannot count as green, so it
  // is dropped rather than defaulted into something that looks finished.
  test("a malformed run is dropped, not defaulted", () => {
    expect(readRun(undefined)).toBeUndefined();
    expect(readRun({ name: "Framework check", status: "completed" })).toBeUndefined();
    expect(readRun({ status: "completed", created_at: "now" })).toBeUndefined();
    expect(readRun({ name: 7, status: "completed", created_at: "now" })).toBeUndefined();
  });

  test("a run still queued has no conclusion, which is not an error", () => {
    expect(readRun({ name: "Framework check", status: "queued", created_at: "now" })).toEqual({
      name: "Framework check",
      status: "queued",
      conclusion: null,
      createdAt: "now",
    });
  });
});

describe("candidate announcement", () => {
  const candidate = {
    base: "0.1.3",
    version: "0.1.3-rc52309221",
    sha: "31e2ce5",
    runUrl: "https://github.com/o/r/actions/runs/1",
  };

  // A reviewer copies one version into the CLI and into two package managers.
  // `mistral apps capability update` takes a SINGLE positional version and
  // rewrites every `@mistralai-capabilities/*` specifier in the app from it, so
  // if these lines ever disagree again that command has no answer.
  test("every install line pins the same version, and the marker leads", () => {
    const body = renderAnnouncement(candidate);
    // The marker must lead: `findAnnouncement` matches on the prefix.
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("mistral apps capability update 0.1.3-rc52309221");
    expect(body).toContain("mistral apps capability add <id> 0.1.3-rc52309221");
    expect(body).toContain("bun add @mistralai-capabilities/<kind>-<id>@0.1.3-rc52309221");
    expect(body).toContain("uv add mistralai-capabilities-<kind>-<id>==0.1.3-rc52309221");
    expect(body).toContain("0.1.3");
  });

  // The Python index lists the normalised spelling. Saying so is what stops the
  // next reader concluding the pin above is wrong.
  test("the body names the spelling the Python index will show", () => {
    expect(renderAnnouncement(candidate)).toContain("`0.1.3rc52309221`");
  });

  test("the pipeline's own comment is the one it rewrites", () => {
    const mine = { id: 2, body: renderAnnouncement(candidate) };
    expect(findAnnouncement([{ id: 1, body: "looks good" }, mine])).toBe(2);
    expect(findAnnouncement([])).toBeUndefined();
  });

  // Somebody quoting the announcement in a reply must not have their comment
  // overwritten on the next commit. The marker has to LEAD the body.
  test("a comment merely quoting the marker is not the pipeline's", () => {
    const quoted = { id: 3, body: `> ${MARKER}\n> nice, but which sha?` };
    expect(findAnnouncement([quoted])).toBeUndefined();
    expect(findAnnouncement([quoted, { id: 4, body: `${MARKER}\nreal` }])).toBe(4);
  });
});
