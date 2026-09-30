#!/usr/bin/env bun
/**
 * rc-announce.ts — tell a pull request which release candidate it has.
 *
 * ONE comment per pull request, rewritten in place on every green commit rather
 * than appended to: only the newest candidate is the one worth installing, and a
 * twenty-commit branch would otherwise bury its own review under twenty
 * near-identical notifications. The comment is found again by an invisible
 * marker, so nothing has to be threaded through the workflow between runs.
 *
 * Candidates publish concurrently — the publish concurrency group is the commit,
 * because cancelling an upload halfway is worse than two of them — so an older
 * commit can finish after the branch has moved on. It must not then overwrite
 * the comment with install lines for code that is no longer the head. The guard
 * has two halves and needs both:
 *
 *   1. This script re-reads the pull request head immediately before writing and
 *      stops unless the head is still its own commit.
 *   2. The `announce` job takes a concurrency lock on the PULL REQUEST, so no
 *      other announcement can run between that read and this write. Without it
 *      the two operations are a check-then-act, and a newer candidate could slip
 *      in between them and be overwritten by the older one.
 *
 * Together they also settle the first-announcement race: two candidates cannot
 * both find no comment and create one, because they cannot run at once.
 *
 *   bun scripts/release/rc/announce.ts
 */

import {
  field,
  isJsonNumber,
  type JsonValue,
  paginate,
  request,
  requiredEnv,
  stringField,
} from "./github-rest";
import { pythonIndexVersion } from "./version";

/**
 * How the comment is found again on the next commit. Invisible in the rendered
 * body, and specific enough that no human writes it by accident.
 */
export const MARKER = "<!-- mistralai-capabilities:rc -->";

export interface Candidate {
  /** The released version this candidate is a candidate for. */
  base: string;
  /** The candidate, one string for both ecosystems. */
  version: string;
  sha: string;
  runUrl: string;
}

/**
 * The comment body. Starts with the marker, so the next run can find it.
 *
 * The CLI block leads, because a capability is consumed by an app and not by a
 * package manager: `mistral apps capability update <version>` rewrites every
 * `@mistralai-capabilities/*` specifier in a generated app in one call. It is
 * the reason the two spellings had to collapse into one -- the command takes a
 * single positional and treats anything starting with a digit as the version.
 * The raw pins below it are the escape hatch for a project that is not a
 * generated app.
 */
export function renderAnnouncement({ base, version, sha, runUrl }: Candidate): string {
  return [
    MARKER,
    `### Release candidate \`${version}\``,
    "",
    "Every capability at this commit is published to Gemfury and Cloudsmith, as a candidate " +
      `for the unreleased \`${base}\`. One version string, everywhere.`,
    "",
    "In a generated app:",
    "",
    "```sh",
    `mistral apps capability update ${version}      # bump every installed capability`,
    `mistral apps capability add <id> ${version}    # add one, at this candidate`,
    "```",
    "",
    "Or pin a package directly:",
    "",
    "```sh",
    `bun add @mistralai-capabilities/<kind>-<id>@${version}`,
    `uv add mistralai-capabilities-<kind>-<id>==${version}`,
    "```",
    "",
    "Pin the exact version: candidates publish under the `rc` npm dist-tag, and a PEP 440",
    "pre-release is invisible to a plain `uv add`. Nothing untagged resolves to one.",
    "",
    `<sub>Built from ${sha} · the Python index normalises the pin to ` +
      `\`${pythonIndexVersion(version)}\`, which is the same version · ` +
      `rewritten on every green commit · [run](${runUrl})</sub>`,
  ].join("\n");
}

/**
 * The id of this pipeline's comment among a pull request's comments, or
 * undefined when it has not posted one yet. Matched on the marker PREFIX: a
 * quoted reply containing the marker further down its body is somebody's
 * comment, not this one's.
 */
export function findAnnouncement(comments: readonly JsonValue[]): number | undefined {
  for (const comment of comments) {
    if (!stringField(comment, "body")?.startsWith(MARKER)) continue;
    const id = field(comment, "id");
    if (isJsonNumber(id)) return id;
  }
  return undefined;
}

async function main(): Promise<void> {
  const token = requiredEnv("GITHUB_TOKEN");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const pr = requiredEnv("PR");
  const sha = requiredEnv("SHA");

  // Read the head immediately before writing, not at the top of the job: the
  // whole point is to shrink the window in which the branch can move under us.
  const pull = await request("GET", `/repos/${repository}/pulls/${pr}`, token);
  const head = stringField(field(pull, "head"), "sha");
  if (head !== sha) {
    console.log(`::notice::#${pr} has moved to ${head} — not announcing the candidate for ${sha}`);
    return;
  }

  const body = renderAnnouncement({
    base: requiredEnv("BASE"),
    version: requiredEnv("VERSION"),
    sha,
    runUrl: requiredEnv("RUN_URL"),
  });

  const comments = (
    await paginate(`/repos/${repository}/issues/${pr}/comments?per_page=100`, token)
  ).flatMap((page) => (Array.isArray(page) ? page : []));
  const existing = findAnnouncement(comments);

  if (existing === undefined) {
    await request("POST", `/repos/${repository}/issues/${pr}/comments`, token, { body });
    console.log(`::notice::announced the candidate on #${pr}`);
  } else {
    await request("PATCH", `/repos/${repository}/issues/comments/${existing}`, token, { body });
    console.log(`::notice::updated the candidate comment on #${pr}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
