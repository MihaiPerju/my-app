#!/usr/bin/env bun
/**
 * rc-version.ts — the release-candidate identity of one commit, rendered into
 * the ONE version string npm and Python both accept.
 *
 * A release candidate is named for the commit it was built from, so a reviewer
 * can install exactly what a PR proposes. That name has to be a single string:
 * a capability is installed by a version, not by an ecosystem
 * (`mistral apps init --registry <pkg>@<version>` passes one), and two spellings
 * mean every consumer that pins both has to know how to translate between them.
 *
 *   0.1.3-rc52309221
 *
 * Legal in both grammars, and it is the same characters in both:
 *
 *   npm      `0.1.3-rc52309221`  semver pre-release, one alphanumeric identifier
 *   PEP 440  `0.1.3-rc52309221`  a `-` before the pre-release segment is allowed
 *
 * PEP 440 NORMALISES that to `0.1.3rc52309221`, which is what a Python index
 * lists and what a lockfile records. It does NOT reject the hyphen: a version
 * specifier is compared after normalisation, so `==0.1.3-rc52309221` matches the
 * dist that `uv build` produced from exactly this string. `pep440Normalized`
 * below spells the index form, for the places that have to show it.
 *
 * WHY THE SHA IS A DECIMAL. PEP 440 requires an INTEGER after `rc` -- letters
 * are legal only in the local segment (`+31e2ce5`), and npm cannot use that: npm
 * semver ignores build metadata when comparing, so `0.1.3-rc0+aaaaaaa` and
 * `0.1.3-rc0+bbbbbbb` are the SAME version to the registry and the second commit
 * of a pull request would be rejected as a duplicate. The one encoding of a hex
 * sha both grammars accept in the pre-release segment is its value in base ten,
 * so `rc<decimal>` is what a candidate carries. It is 1:1 with the short sha and
 * reversible -- `printf '%07x' 52309221` -- and the announcement and the run
 * summary print the full sha next to it, because the number is unreadable.
 *
 * The sha is glued to `rc` as ONE identifier for npm's sake as well: semver
 * reads a bare all-digit identifier as a NUMBER, and a leading zero makes it
 * invalid, so `0.1.3-rc.0123456` is not a version at all.
 *
 *   bun scripts/release/rc/version.ts <sha> [--base <version>]
 */

import { $ } from "bun";

/** Length of the sha that names a release candidate. Matches `git rev-parse --short`. */
export const RC_SHA_LENGTH = 7;

/** A released tag: `v` plus a plain three-part version, which is all `publish.yaml` cuts. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * The commit sha, shortened and validated. A sha reaches this from a workflow
 * event payload and ends up in a published artifact name, so anything that is
 * not lowercase hex is rejected rather than normalised.
 */
export function shortSha(sha: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`not a commit sha: '${sha}'`);
  }
  return sha.slice(0, RC_SHA_LENGTH);
}

/**
 * The highest `vX.Y.Z` among `tags`, compared numerically per component —
 * `v0.10.0` outranks `v0.9.0`, which a lexical sort gets backwards. Anything
 * that is not a plain release tag (a pre-release, an unrelated tag) is ignored.
 * Undefined when nothing has been released yet.
 */
export function latestReleaseTag(tags: readonly string[]): string | undefined {
  const parsed = tags
    .map((tag) => RELEASE_TAG.exec(tag.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ tag: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] as const }));
  if (parsed.length === 0) return undefined;
  parsed.sort(
    (a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2],
  );
  return parsed[0]!.tag;
}

/**
 * The version a candidate is a candidate FOR: the next patch after the last
 * release. A candidate is never named for a version already published, so
 * `0.1.2` released means candidates are `0.1.3-rc…`. With nothing released yet
 * the first candidates target `0.0.1`.
 */
export function nextPatch(latestTag: string | undefined): string {
  if (latestTag === undefined) return "0.0.1";
  const m = RELEASE_TAG.exec(latestTag);
  if (!m) throw new Error(`not a release tag: '${latestTag}'`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * The version a candidate publishes under, in both ecosystems, character for
 * character. The short sha becomes the integer PEP 440 demands after `rc`:
 * base-ten of the 7 hex digits, bijective with them and reversible with
 * `printf '%07x'`. 28 bits, so it is an exact `Number` with room to spare.
 */
export function renderRcVersion(base: string, sha: string): string {
  return `${base}-rc${Number.parseInt(shortSha(sha), 16)}`;
}

/**
 * What a Python index calls a version this module rendered. PEP 440 normalises
 * a version by, among other things, dropping the separator before the
 * pre-release segment, so `0.1.3-rc52309221` is listed as `0.1.3rc52309221`.
 * Nothing installs by this string — the pin matches it after normalisation —
 * but a human reading the index sees it, so the announcement says it out loud
 * rather than letting it look like the publish went wrong. Not general PEP 440
 * normalisation: only the one rewrite `renderRcVersion` output needs. A release
 * (`0.1.3`) is already normalised and comes back unchanged.
 */
export function pythonIndexVersion(version: string): string {
  return version.replace(/-(?=rc\d)/, "");
}

export interface RcVersion {
  /** The release this candidate targets, `X.Y.Z`. */
  base: string;
  /** The candidate itself, `X.Y.Z-rc<decimal-sha>`. */
  version: string;
}

/** The identity of one candidate. The only entry point callers should need. */
export function rcVersion(latestTag: string | undefined, sha: string): RcVersion {
  const base = nextPatch(latestTag);
  return { base, version: renderRcVersion(base, sha) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let sha: string | undefined;
  let baseOverride: string | undefined;
  let sawBase = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") {
      sawBase = true;
      baseOverride = argv[++i];
    } else sha ??= argv[i];
  }
  // A `--base` with no value must not fall back to the tag scan: the caller
  // asked for a specific base and would get a different one in silence.
  if (!sha || (sawBase && !baseOverride)) {
    throw new Error("usage: rc-version.ts <sha> [--base <version>]");
  }

  // Every tag in the repo, not only the ones reachable from this checkout: a
  // candidate targets the next patch after the last RELEASE, which is a property
  // of the project, not of the branch it was cut from. No `v*` filter here --
  // Bun's shell would glob it against the working directory, and
  // `latestReleaseTag` discards everything that is not a release tag anyway.
  const tags =
    baseOverride === undefined
      ? (await $`git tag --list`.quiet().text()).split("\n")
      : [`v${baseOverride}`];
  const { base, version } = rcVersion(latestReleaseTag(tags), sha);

  // `key=value` lines, appendable straight to $GITHUB_OUTPUT.
  console.log(`base=${base}`);
  console.log(`version=${version}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
