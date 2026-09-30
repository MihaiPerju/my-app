#!/usr/bin/env bun
/**
 * Resync the generated app's copy of the anti-slop plugin from the canonical one.
 *
 * `tools/oxlint/anti-slop/` is the source; the copy under `capabilities/tooling/code-quality/template/` is what a
 * generated app lints with. Run this after changing a rule, and commit both. `vendor.test.ts`
 * fails the build when they drift.
 *
 *     bun tests/registry/anti-slop/vendor.gen.ts
 */
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

import { capabilityDir, REGISTRY_ROOT, walk } from "../support/template-tree";

const canonical = join(REGISTRY_ROOT, "tools", "oxlint", "anti-slop");
const vendored = join(capabilityDir("code-quality"), "template", "tools", "oxlint", "anti-slop");

// Removed first so a rule deleted upstream does not linger in the copy — a stale rule file is
// still loaded by the plugin index it is imported from, so leaving one behind is not inert.
rmSync(vendored, { force: true, recursive: true });
cpSync(canonical, vendored, { recursive: true });
console.log(`synced ${walk(vendored).length} files to ${vendored}`);
