/**
 * The bucket compose overlay must agree with the capability's declared defaults.
 *
 * Bucket's Python object-storage backends are unit-tested in its `package/py`; this file covers a
 * different concern — the local dev stack's config. `invoke dev` seeds the bucket container from this
 * overlay's `${VAR:-default}` values, while the app authenticates using `capability.json`'s
 * `envVars`. Those are two files edited independently, so if the bucket, credential, or published
 * port defaults drift apart the app talks to a store it cannot reach. compose-gating proves the
 * overlay renders and its `depends_on` resolves; this proves its service shape and that its defaults
 * match the capability's — the parity nothing else checks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilityDir, readJson } from "../support/template-tree";

interface Service {
  image?: string;
  command?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: string[] };
}

const BUCKET = capabilityDir("bucket");
// The bucket Compose overlay is owned by the hidden docker-compose-bucket integration capability;
// its declared env defaults stay in the bucket capability manifest. This test keeps the two in
// agreement.
// SAFETY: compose.bucket.yaml is a repo-owned overlay; a shape mismatch fails the assertions below.
const overlay = Bun.YAML.parse(
  readFileSync(
    join(
      capabilityDir("docker-compose-bucket"),
      "template",
      "deploy",
      "compose",
      "compose.bucket.yaml",
    ),
    "utf8",
  ),
) as { services?: Record<string, Service> };
const envVars = readJson<{ envVars: Record<string, string> }>(
  join(BUCKET, "capability.json"),
).envVars;

// A compose value written as `${VAR:-default}` documents `default`; that default is what the local
// stack runs with, so it is what must agree with the capability's declared envVars.
const composeDefault = (raw: string | undefined): string | undefined =>
  raw === undefined ? undefined : (/^\$\{[^:}]+:-([^}]*)\}$/.exec(raw)?.[1] ?? raw);

describe("bucket compose overlay", () => {
  test("defines the bucket S3 service on the declared endpoint with a health check", () => {
    const bucket = overlay.services?.bucket;
    expect(bucket, "compose.bucket.yaml defines no bucket service").toBeDefined();
    expect(bucket!.image).toMatch(/^rustfs\/rustfs:/);
    // The published loopback port must default to the one the capability advertises as the S3
    // endpoint. The host side is BUCKET_PORT (a root .env value), so it can move per app.
    const endpoint = envVars.INGESTION_S3_ENDPOINT_URL;
    expect(endpoint, "capability.json declares no INGESTION_S3_ENDPOINT_URL").toBeDefined();
    const port = new URL(endpoint!).port;
    expect(bucket!.ports ?? []).toContain(`127.0.0.1:\${BUCKET_PORT:-${port}}:${port}`);
    expect(bucket!.healthcheck?.test?.join(" ")).toContain("/health");
  });

  test("the one-shot setup waits for a healthy bucket service and seeds the declared bucket", () => {
    const setup = overlay.services?.["bucket-setup"];
    expect(setup, "compose.bucket.yaml defines no bucket-setup service").toBeDefined();
    expect(setup!.image).toBe("rustfs/rc:v0.1.36");
    expect(setup!.depends_on?.bucket?.condition).toBe("service_healthy");
    const command = setup!.command?.join("\n") ?? "";
    expect(command).toContain("rc alias set");
    expect(command).toContain("rc mb --ignore-existing");
    expect(command).toContain("rc mirror --overwrite --remove");
    expect(composeDefault(setup!.environment?.INGESTION_S3_BUCKET)).toBe(
      envVars.INGESTION_S3_BUCKET,
    );
  });

  test("both services' credential defaults match the capability's declared defaults", () => {
    // bucket-setup authenticates to the store independently of the server, so a drift in either
    // service's default breaks the stack while the other still matches — assert both.
    for (const service of ["bucket", "bucket-setup"] as const) {
      const env = overlay.services?.[service]?.environment;
      expect(composeDefault(env?.RUSTFS_ACCESS_KEY), `${service} access key`).toBe(
        envVars.INGESTION_S3_ACCESS_KEY_ID,
      );
      expect(composeDefault(env?.RUSTFS_SECRET_KEY), `${service} secret key`).toBe(
        envVars.INGESTION_S3_SECRET_ACCESS_KEY,
      );
    }
  });
});
