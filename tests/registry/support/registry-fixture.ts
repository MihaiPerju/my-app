import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CapabilityManifest } from "../../../scripts/shared/manifests";

/** Authored manifest fixture; `path` is normally discovered but may be written by rejection tests. */
type CapabilityFixture = Omit<CapabilityManifest, "path"> & { path?: string };

/** Write a `capability.json` at `capabilities/<dirPath>/` under `root`. */
export const writeCap = (root: string, dirPath: string, manifest: CapabilityFixture): void => {
  const dir = join(root, "capabilities", dirPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "capability.json"), JSON.stringify(manifest, null, 2));
};

/** Run against a temporary registry with a minimal descriptor-v3 config. */
export const withRepo = (build: (root: string) => void, run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "registry-fixture-"));
  try {
    writeFileSync(
      join(root, "registry.config.json"),
      JSON.stringify(
        {
          id: "reg",
          sources: { ts: "https://example.test/ts/" },
          kinds: [{ id: "feature", title: "Features", weight: 0, min: 0 }],
        },
        null,
        2,
      ),
    );
    build(root);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
