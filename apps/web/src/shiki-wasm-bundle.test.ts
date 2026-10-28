/**
 * Keep Shiki's raw Wasm export out of the production SSR build. Rolldown selects the `unwasm`
 * condition on Linux and otherwise treats `onig.wasm` as JavaScript, failing while resolving its
 * `env` import. The Vite alias must point at Shiki's portable inlined wrapper instead.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Vite aliases Shiki's Wasm import to its JavaScript wrapper", () => {
  const config = readFileSync(
    resolve(import.meta.dir, "..", "vite-plugins", "mistral-design-system.ts"),
    "utf8",
  );

  expect(config).toContain('{ find: "shiki/wasm", replacement: "shiki/dist/wasm.mjs" }');
});
