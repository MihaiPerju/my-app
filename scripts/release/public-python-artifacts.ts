/**
 * Materialize the Python artifact sets produced by `build-python.ts`.
 *
 * `dist/py/` is the complete internal set and must retain every Python
 * distribution. `dist/py-public/` is a strict subset: only artifacts built from
 * a capability whose `capability.json` has `metadata.public === true` are copied
 * there. Publishers select one of these directories; they never reimplement the
 * visibility decision from distribution names.
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface PythonArtifactOutputs {
  internal: string;
  public: string;
}

/** Reset both output sets, including an explicitly empty public set. */
export function resetPythonArtifactOutputs(root: string): PythonArtifactOutputs {
  const internal = join(root, "dist", "py");
  const publicDir = join(root, "dist", "py-public");
  for (const directory of [internal, publicDir]) {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
  }
  return { internal, public: publicDir };
}

/**
 * Copy one capability's completed build into the canonical output sets.
 * Internal retention is unconditional; public retention is strict opt-in.
 */
export function copyPythonArtifacts(
  stage: string,
  artifacts: readonly string[],
  outputs: PythonArtifactOutputs,
  isPublic: boolean,
): void {
  for (const artifact of artifacts) {
    copyFileSync(join(stage, artifact), join(outputs.internal, artifact));
    if (isPublic) copyFileSync(join(stage, artifact), join(outputs.public, artifact));
  }
}
