#!/usr/bin/env bun
/**
 * Regenerate the committed template inventory snapshot (`template-inventory.snapshot.json`).
 *
 * Run this only after an intentional change to a capability's template/ zone. The diff is what a
 * reviewer inspects:
 *
 *     bun tests/registry/inventory/template-inventory.gen.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { capabilityLocalIds, contributedPaths } from "../support/template-tree";

const snapshot = Object.fromEntries(
  capabilityLocalIds.map((id) => [id, contributedPaths(id).toSorted()]),
);
const path = join(import.meta.dir, "template-inventory.snapshot.json");
writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`wrote ${capabilityLocalIds.length} capabilities to ${path}`);
