import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilityDir } from "../support/template-tree";

// How the API reloads (watched trees, graceful-shutdown bound) lives in `api.dev` alone. A
// launcher that inlines its own server command drifts from it: `fastapi dev` never bounded the
// shutdown, so one open chat stream wedged every reload.
test.each([
  "template/apps/api/project.json",
  "template/deploy/docker/Dockerfile.api",
  "capability.json",
])("%s serves the dev API through api.dev", (path) => {
  const source = readFileSync(join(capabilityDir("fastapi"), path), "utf8");

  expect(source).toContain("python -m api.dev");
  expect(source).not.toContain("fastapi dev");
});
