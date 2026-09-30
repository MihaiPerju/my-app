/**
 * Per-capability template inventory guard.
 *
 * This diffs each capability's contributed path set against the committed snapshot
 * (`template-inventory.snapshot.json`) and fails on any unexplained addition or removal. Regenerate the
 * snapshot only when the change is intended, with
 *
 *     bun tests/registry/inventory/template-inventory.gen.ts
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  capabilityLocalIds,
  contributedPaths,
  isVendored,
  readJson,
} from "../support/template-tree";

const SNAPSHOT_PATH = join(import.meta.dir, "template-inventory.snapshot.json");
const snapshot = readJson<Record<string, string[]>>(SNAPSHOT_PATH);

describe("template inventory", () => {
  test("directory-only ignore rules do not exclude same-named files", () => {
    expect(isVendored("node_modules")).toBe(true);
    expect(isVendored("node_modules/dependency/index.js")).toBe(false);
    expect(isVendored("src/node_modules/dependency/index.js")).toBe(false);
  });

  test("the snapshot pins the same capability set that exists on disk", () => {
    // A capability added or removed without regenerating the snapshot is itself a signal:
    // its whole contributed set is unreviewed.
    expect(Object.keys(snapshot).toSorted()).toEqual(capabilityLocalIds.toSorted());
  });

  test("every capability contributes exactly its pinned set of paths", () => {
    const drift: string[] = [];
    for (const id of capabilityLocalIds) {
      const live = new Set(contributedPaths(id));
      const pinned = new Set(snapshot[id] ?? []);
      const added = [...live].filter((p) => !pinned.has(p)).toSorted();
      const removed = [...pinned].filter((p) => !live.has(p)).toSorted();
      for (const p of added) drift.push(`${id}: + ${p}`);
      for (const p of removed) drift.push(`${id}: - ${p}`);
    }
    // A non-empty list means the tree and the snapshot disagree. If the change was intended,
    // rerun `bun tests/registry/inventory/template-inventory.gen.ts` and commit the snapshot.
    expect(drift).toEqual([]);
  });
});
