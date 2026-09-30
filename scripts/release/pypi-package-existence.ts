#!/usr/bin/env bun
/**
 * pypi-package-existence.ts — report which projects in the public dist set PyPI already holds.
 *
 * Neither answer can fail the run on its own. A pending publisher does not create
 * the project, so a name the service user has correctly registered still answers
 * 404 until the first upload; and an existing project is the normal state for
 * every capability after its first release. Ownership cannot be checked either:
 * PyPI exposes no owner API, and `author` and `maintainer` are metadata the
 * uploader wrote rather than account roles.
 *
 * What the report is for is the approval gate on `publish-pypi`. A project the
 * run is about to claim for the first time shows as `new`, and a name that comes
 * back `held` on a capability's first public release is somebody else's. The
 * maintainer sees both lists, unauthenticated and before any credential is in
 * play, rather than approving an irreversible upload blind.
 *
 *   bun scripts/release/pypi-package-existence.ts [directory]
 */

import { existsSync, readdirSync } from "node:fs";

import { pyDistNameFromArtifact } from "../shared/capability-identity";

const PUBLIC_DIST_DIR = "dist/py-public";
const PYPI_JSON_BASE = "https://pypi.org/pypi/";

/** Answers PyPI's HTTP status for one project name. */
export type ProjectProbe = (name: string) => Promise<number>;

/** `held` if pypi.org already has the project, `new` if this run would create it. */
export type ProjectState = "held" | "new";

/**
 * Every distinct project the public dist directory would upload, sorted. An
 * absent directory counts as empty, matching the publish step: the build states
 * an empty public set and an artifact upload drops the empty directory.
 */
export function publicProjectNames(directory = PUBLIC_DIST_DIR): string[] {
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(whl|tar\.gz)$/.test(entry.name))
    .map((entry) => entry.name);
  return [...new Set(files.map(pyDistNameFromArtifact))].toSorted((a, b) => a.localeCompare(b));
}

export function projectUrl(name: string): string {
  return new URL(`${encodeURIComponent(name)}/json`, PYPI_JSON_BASE).href;
}

const probePypi: ProjectProbe = async (name) => (await fetch(projectUrl(name))).status;

/**
 * The state of each name, in the order given. Any status but 200 or 404 throws:
 * a rate limit or an outage read as either answer would put a wrong list in
 * front of whoever approves the upload.
 */
export async function projectStates(
  names: readonly string[],
  probe: ProjectProbe = probePypi,
): Promise<Map<string, ProjectState>> {
  const states = new Map<string, ProjectState>();
  for (const name of names) {
    const status = await probe(name);
    if (status === 200) states.set(name, "held");
    else if (status === 404) states.set(name, "new");
    else {
      throw new Error(
        `pypi.org answered ${status} for ${name}; cannot tell whether the project exists`,
      );
    }
  }
  return states;
}

/**
 * Print one line per project and a `::warning::` naming the ones this run would
 * create, which is what the approver has to recognise as expected or not.
 */
export async function preflight(
  names: readonly string[],
  probe?: ProjectProbe,
): Promise<Map<string, ProjectState>> {
  if (names.length === 0) {
    console.log("No public Python distributions to check.");
    return new Map();
  }

  const states = await projectStates(names, probe);
  for (const [name, state] of states) console.log(`${state.padEnd(4)} ${name}`);

  const created = [...states].filter(([, state]) => state === "new").map(([name]) => name);
  if (created.length > 0) {
    console.log(
      `::warning::This release claims ${created.length} new pypi.org project(s): ` +
        `${created.join(", ")}. Each needs a pending publisher on the service user for ` +
        `mistralai/mistralai-capabilities, workflow publish.yaml, environment publish, or the ` +
        `upload will be rejected. A name you did not expect to be new, or one listed as held on a ` +
        `capability's first public release, is somebody else's project.`,
    );
  }
  return states;
}

if (import.meta.main) {
  try {
    await preflight(publicProjectNames(process.argv[2] ?? PUBLIC_DIST_DIR));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
