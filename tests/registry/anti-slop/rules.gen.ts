#!/usr/bin/env bun
/**
 * Regenerate the pinned anti-slop invalid-diagnostic counts (`rules.snapshot.json`).
 *
 * Run this only after an intentional change to a rule or its fixtures. The diff is the regression
 * signal a reviewer inspects: a count that moves without a matching fixture change means a rule
 * started firing differently.
 *
 *     bun tests/registry/anti-slop/rules.gen.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { invalidCountsByRule, scanFixtures } from "./fixture-scan";

const counts = invalidCountsByRule(scanFixtures());
const sorted = Object.fromEntries(
  Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)),
);
const path = join(import.meta.dir, "rules.snapshot.json");
writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${Object.keys(sorted).length} rule counts to ${path}`);
