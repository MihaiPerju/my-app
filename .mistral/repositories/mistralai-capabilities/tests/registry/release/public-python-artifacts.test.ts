import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyPythonArtifacts,
  resetPythonArtifactOutputs,
} from "../../../scripts/release/public-python-artifacts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cap-public-py-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function stage(name: string) {
  const directory = join(root, "stage", name);
  mkdirSync(directory, { recursive: true });
  const artifacts = [
    `mistralai_capabilities_${name}-1.2.3-py3-none-any.whl`,
    `${name}-1.2.3.tar.gz`,
  ];
  for (const artifact of artifacts) writeFileSync(join(directory, artifact), artifact);
  return { directory, artifacts };
}

describe("canonical Python artifact sets", () => {
  test("retains all internal dists and copies only strict public capabilities", () => {
    const outputs = resetPythonArtifactOutputs(root);
    const publicCapability = stage("base_core");
    const privateCapability = stage("feature_chat");

    copyPythonArtifacts(publicCapability.directory, publicCapability.artifacts, outputs, true);
    copyPythonArtifacts(privateCapability.directory, privateCapability.artifacts, outputs, false);

    expect(readdirSync(outputs.internal).toSorted()).toEqual(
      [...publicCapability.artifacts, ...privateCapability.artifacts].toSorted(),
    );
    expect(readdirSync(outputs.public).toSorted()).toEqual(publicCapability.artifacts.toSorted());
  });

  test("materializes an explicit empty public set and removes stale artifacts", () => {
    const stalePublic = join(root, "dist", "py-public", "stale.whl");
    mkdirSync(join(root, "dist", "py-public"), { recursive: true });
    writeFileSync(stalePublic, "stale");

    const outputs = resetPythonArtifactOutputs(root);
    const privateCapability = stage("backend_api");
    copyPythonArtifacts(privateCapability.directory, privateCapability.artifacts, outputs, false);

    expect(existsSync(outputs.public)).toBe(true);
    expect(readdirSync(outputs.public)).toEqual([]);
    expect(readdirSync(outputs.internal).toSorted()).toEqual(
      privateCapability.artifacts.toSorted(),
    );
  });
});
