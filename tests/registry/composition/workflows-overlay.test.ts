/**
 * Both workflows Compose overlays must expose the worker's liveness to Docker.
 *
 * The dev target runs the worker under `watchfiles`, which stays alive after the worker process
 * dies at startup (it waits for the next edit). Without a healthcheck, a worker that crashes on
 * every start, such as the missing-`cryptography` ImportError, shows as "Up" and the stack looks
 * fine. The probe only works if the overlay also starts the SDK health server on the address the
 * probe reads, so both halves are asserted together, for the runtime and the dev overlay alike.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilities, renderHbs } from "../support/selection";
import { capabilityDir } from "../support/template-tree";

interface Service {
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
}

const OVERLAY_DIR = join(
  capabilityDir("docker-compose-workflows"),
  "template",
  "deploy",
  "compose",
);
// Every gate on: the rendered shape must hold for the largest selection, and the gates in these
// overlays only add environment entries and `depends_on` edges.
const EVERYTHING = new Set(capabilities.keys());

const workerService = (file: string): Service => {
  const rendered = renderHbs(readFileSync(join(OVERLAY_DIR, file), "utf8"), EVERYTHING);
  // SAFETY: a repo-owned overlay; a shape mismatch fails the assertions below.
  const parsed = Bun.YAML.parse(rendered) as { services?: Record<string, Service> };
  const service = parsed.services?.workflows;
  expect(service, `${file}: no workflows service`).toBeDefined();
  return service!;
};

describe("workflows Compose overlays", () => {
  for (const file of ["compose.workflows.yaml.hbs", "compose.workflows.dev.yaml.hbs"]) {
    test(`${file} probes the SDK health server it starts`, () => {
      const service = workerService(file);
      const host = service.environment?.HEALTH_SERVER_HOST;
      const port = service.environment?.HEALTH_SERVER_PORT;
      expect(
        host,
        `${file}: HEALTH_SERVER_HOST unset, so the SDK starts no health server`,
      ).toBeDefined();
      expect(
        port,
        `${file}: HEALTH_SERVER_PORT unset, so the SDK starts no health server`,
      ).toBeDefined();
      const probe = service.healthcheck?.test?.join(" ") ?? "";
      expect(
        probe,
        `${file}: no healthcheck on the worker, so a crash-looping worker shows as "Up"`,
      ).toContain(`http://${host}:${port}/health`);
    });
  }
});
