/**
 * A tripwire on the number of `framer-motion` copies this app ships. `@mistralai/ui` ships raw
 * TypeScript, so this app's bundler resolves its import. Without `resolve.dedupe`, Vite bundles two
 * copies that run on separate clocks and share no motion context, so elements tear. The test asserts the dedupe entry.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const PACKAGE = "framer-motion";

// Counting versions this way needs bun's isolated store, which only exists under the default
// linker. An app generated from the capability registry is installed with `linker = "hoisted"`
// (the CLI writes that bunfig), where duplicates collapse into nested `node_modules` and the
// store is absent — so there is nothing to count and the guard below cannot speak.
const STORE = join(REPO_ROOT, "node_modules", ".bun");

function installedCopies(): string[] {
  // Bun's store names each entry `<package>@<version>+<hash>`, one directory per resolved
  // version, so counting them counts the versions actually installed.
  return readdirSync(STORE)
    .filter((entry) => entry.startsWith(`${PACKAGE}@`))
    .toSorted();
}

describe("framer-motion copies", () => {
  test.skipIf(!existsSync(STORE))(
    "the bundler is told to dedupe it, because more than one version is installed",
    () => {
      const copies = installedCopies();
      // Guard the guard: if the install ever collapses to one version this assertion fails, and
      // the dedupe entry below can be retired rather than cargo-culted forever.
      expect(copies.length).toBeGreaterThan(1);

      const config = readFileSync(
        join(WEB_ROOT, "vite-plugins", "mistral-design-system.ts"),
        "utf8",
      );
      const dedupe = /dedupe:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";
      expect(dedupe).toContain(`"${PACKAGE}"`);
    },
  );
});
