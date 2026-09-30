import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanArtifact } from "../../../scripts/compliance/archive-scanner";
import {
  assertCapabilityCopyComplete,
  assertPackedPublicCapabilityClosure,
  assertPublicDescriptorClosure,
  readPackedCapabilityFromArtifact,
  readPackedDescriptorFromArtifact,
  selectPythonArtifacts,
} from "../../../scripts/compliance/check-public-artifacts";
import { forbiddenReferenceLabels } from "../../../scripts/compliance/public-artifact-policy";
import { REQUIRED_WORKFLOWS } from "../../../scripts/release/rc/gate";
import { withRepo, writeCap } from "../support/registry-fixture";
import { REGISTRY_ROOT } from "../support/template-tree";

const INTERNAL_URL_POLICY = "internal URL hostname";

const CREDENTIAL_POLICY_CASES = [
  {
    label: "Mistral registry-token environment variable",
    positive: 'MISTRAL_REGISTRY_TOKEN: "${{ secrets.REGISTRY_TOKEN }}"',
    nearMiss: "MISTRAL_REGISTRY_TOKEN_BACKUP=value",
  },
  {
    label: "Mistral registry-user environment variable",
    positive: 'export MISTRAL_REGISTRY_USER="service-user"',
    nearMiss: "MY_MISTRAL_REGISTRY_USER=value",
  },
  {
    label: "Gemfury pull-token environment variable",
    positive: 'token = os.environ["GEMFURY_PULL_TOKEN"]',
    nearMiss: "GEMFURY_PULL_TOKEN_FILE=/tmp/token",
  },
  {
    label: "npm authentication-token environment variable",
    positive: "//registry.example/:_authToken=${NODE_AUTH_TOKEN}",
    nearMiss: "NODE_AUTH_TOKENIZER=enabled",
  },
  {
    label: "Python registry-user environment variable",
    positive: "ARG REGISTRY_PY_USER=service-user",
    nearMiss: "PUBLIC_REGISTRY_PY_USER=anonymous",
  },
  {
    label: "uv named-index username environment variable",
    positive: "UV_INDEX_FUTURE_PRIVATE_2_USERNAME=service-user",
    nearMiss: "UV_INDEX_FUTURE_PRIVATE_2_USERNAME_FILE=/tmp/user",
  },
  {
    label: "uv named-index password environment variable",
    positive: 'UV_INDEX_ANOTHER_INDEX_PASSWORD: "${{ secrets.INDEX_PASSWORD }}"',
    nearMiss: "UV_INDEX_ANOTHER_INDEX_PASSWORD_HINT=none",
  },
  {
    label: "npm authentication-token config key",
    positive: "//registry.example/:_authToken=${PUBLIC_TOKEN}",
    nearMiss: "This registry needs no auth token.",
  },
] as const;

interface Workflow {
  jobs?: Record<string, { steps?: { run?: string }[] }>;
}

function workflow(path: string): Workflow {
  // SAFETY: every field the test reads is optional; a non-workflow YAML shape becomes `undefined`
  // and fails the relevant assertion rather than granting a default value.
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;
}

function commands(job: { steps?: { run?: string }[] } | undefined): string[] {
  return job?.steps?.flatMap((step) => (step.run === undefined ? [] : [step.run])) ?? [];
}

function violatesInternalUrlPolicy(text: string): boolean {
  return forbiddenReferenceLabels(text).includes(INTERNAL_URL_POLICY);
}

describe("public artifact forbidden-reference policy", () => {
  test("validates packed public descriptor and capability reference closure", () => {
    const publicCapabilities = [{ id: "core", kind: "base", packages: ["ts"], path: "base/core" }];
    const descriptor = {
      sources: { ts: "https://registry.npmjs.org", py: "https://pypi.org/simple" },
      kinds: [{ id: "base" }],
      capabilities: [{ id: "core", kind: "base", packages: ["ts"] }],
    };
    expect(() => assertPublicDescriptorClosure(descriptor, publicCapabilities)).not.toThrow();
    expect(() =>
      assertPublicDescriptorClosure(
        {
          ...descriptor,
          capabilities: [
            ...descriptor.capabilities,
            { id: "private", kind: "feature", packages: ["ts"] },
          ],
        },
        publicCapabilities,
      ),
    ).toThrow("capability set mismatch");
    expect(() =>
      assertPublicDescriptorClosure(
        {
          ...descriptor,
          capabilities: [
            { id: "core", kind: "base", packages: ["ts"], dependencies: ["feature/private"] },
          ],
        },
        publicCapabilities,
      ),
    ).toThrow("outside the public closure");
    expect(() =>
      assertPackedPublicCapabilityClosure(
        { id: "core", kind: "base", metadata: { public: true }, dependencies: [] },
        publicCapabilities,
        "@mistralai-capabilities/base-core",
      ),
    ).not.toThrow();
    expect(() =>
      assertPackedPublicCapabilityClosure(
        {
          id: "core",
          kind: "base",
          metadata: { public: true },
          activatedWhen: { allOf: ["feature/private"] },
        },
        publicCapabilities,
        "@mistralai-capabilities/base-core",
      ),
    ).toThrow("outside the public closure");
  });

  test("rejects non-canonical descriptor source endpoints", () => {
    const publicCapabilities = [{ id: "core", kind: "base", packages: ["ts"], path: "base/core" }];
    expect(() =>
      assertPublicDescriptorClosure(
        {
          sources: {
            ts: "https://registry.npmjs.org/?token=secret",
            py: "https://pypi.org/simple/",
          },
          kinds: [{ id: "base" }],
          capabilities: [{ id: "core", kind: "base", packages: ["ts"] }],
        },
        publicCapabilities,
      ),
    ).toThrow("anonymous npm/PyPI endpoints");
  });

  test("matches each packed capability manifest identity to its plan entry name", () => {
    const publicCapabilities = [{ id: "core", kind: "base", packages: ["ts"], path: "base/core" }];
    expect(() =>
      assertPackedPublicCapabilityClosure(
        { id: "core", kind: "base", metadata: { public: true } },
        publicCapabilities,
        "@mistralai-capabilities/feature-core",
      ),
    ).toThrow("manifest identity");
  });

  test("rejects internal hostnames when they occur in URLs", () => {
    expect(violatesInternalUrlPolicy("https://service.team.internal/v1")).toBe(true);
    expect(violatesInternalUrlPolicy("https://service.team.internal?health=1")).toBe(true);
    expect(violatesInternalUrlPolicy("https://service.team.internal#status")).toBe(true);
    expect(violatesInternalUrlPolicy("postgresql://user:pass@database.corp:5432/app")).toBe(true);
    expect(violatesInternalUrlPolicy("ssh://git@internal.example.com/repository")).toBe(true);
  });

  test("does not treat dotted code identifiers as hostnames", () => {
    expect(violatesInternalUrlPolicy("from api.routers.api.internal.health import readiness")).toBe(
      false,
    );
    expect(violatesInternalUrlPolicy('create_api_router("api.routers.api.internal")')).toBe(false);
  });

  test("allows Google's documented GCE metadata endpoint", () => {
    expect(
      violatesInternalUrlPolicy(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
      ),
    ).toBe(false);
  });

  test("rejects credential environment references and npm authentication keys", () => {
    for (const { label, positive, nearMiss } of CREDENTIAL_POLICY_CASES) {
      expect(forbiddenReferenceLabels(positive), `${label}: positive`).toContain(label);
      expect(forbiddenReferenceLabels(nearMiss), `${label}: near miss`).not.toContain(label);
    }

    expect(forbiddenReferenceLabels("No package-registry token is required.")).not.toEqual(
      expect.arrayContaining(CREDENTIAL_POLICY_CASES.map(({ label }) => label)),
    );
    expect(forbiddenReferenceLabels("_authToken is not configured here.")).not.toContain(
      "npm authentication-token config key",
    );
    expect(forbiddenReferenceLabels("UV_INDEX_PASSWORD=value")).not.toContain(
      "uv named-index password environment variable",
    );
  });

  test("retains the exact private-service policies without substring matches", () => {
    expect(forbiddenReferenceLabels("https://pypi.fury.io/mistralai/")).toContain(
      "Gemfury reference",
    );
    expect(forbiddenReferenceLabels("https://npm.cloudsmith.io/mistralai/private/")).toContain(
      "Cloudsmith reference",
    );
    expect(forbiddenReferenceLabels("Gemfury for an internal app")).toContain("Gemfury reference");
    expect(forbiddenReferenceLabels("Cloudsmith for a customer app")).toContain(
      "Cloudsmith reference",
    );
    expect(forbiddenReferenceLabels("https://github.com/mistralai/private-repository")).toContain(
      "Mistral GitHub organization link",
    );

    expect(forbiddenReferenceLabels("https://notfury.io/")).not.toContain("Gemfury reference");
    expect(forbiddenReferenceLabels("https://fury.io.example.com/")).not.toContain(
      "Gemfury reference",
    );
    expect(forbiddenReferenceLabels("https://cloudsmith.io.example.com/")).not.toContain(
      "Cloudsmith reference",
    );
    expect(forbiddenReferenceLabels("GEMFURY_PULL_TOKEN")).not.toContain("Gemfury reference");
    expect(forbiddenReferenceLabels("gemfury_token")).not.toContain("Gemfury reference");
    expect(forbiddenReferenceLabels("https://notgithub.com/mistralai/example")).not.toContain(
      "Mistral GitHub organization link",
    );
  });

  test("makes public-artifact compliance part of the RC-required Framework check", () => {
    const frameworkWorkflow = workflow(
      join(REGISTRY_ROOT, ".github", "workflows", "framework-check.yaml"),
    );
    expect(REQUIRED_WORKFLOWS).toContain("Framework check");
    expect(commands(frameworkWorkflow.jobs?.["public-artifacts"])).toContain(
      "bun run public-artifacts:check",
    );
    expect(
      existsSync(join(REGISTRY_ROOT, ".github", "workflows", "public-artifact-check.yaml")),
    ).toBe(false);
  });

  test("release CI invokes the canonical artifact builder", () => {
    const publishWorkflow = workflow(
      join(REGISTRY_ROOT, ".github", "workflows", "publish-core.yaml"),
    );
    expect(commands(publishWorkflow.jobs?.build)).toContain(
      'bun scripts/release/build-artifacts.ts "$VERSION"',
    );
  });

  test("rejects a staged checkout with a truncated capability catalogue", () => {
    const fixture = mkdtempSync(join(tmpdir(), "public-capability-copy-test-"));
    try {
      const checkout = join(fixture, "checkout");
      const capabilityRoot = join(checkout, "capabilities", "feature", "only-one");
      mkdirSync(capabilityRoot, { recursive: true });
      writeFileSync(
        join(capabilityRoot, "capability.json"),
        JSON.stringify({
          id: "only-one",
          kind: "feature",
          version: "1.0.0",
          packages: ["ts"],
          metadata: { public: false },
        }),
      );

      expect(() => assertCapabilityCopyComplete(2, checkout)).toThrow(
        "source has 2, staged checkout has 1",
      );
      expect(() => assertCapabilityCopyComplete(1, checkout)).not.toThrow();
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("rejects a private distribution injected into the public Python output", () => {
    const fixture = mkdtempSync(join(tmpdir(), "public-python-selection-test-"));
    try {
      const pyDir = join(fixture, "capabilities", "feature", "public-widget", "package", "py");
      const publicDir = join(fixture, "dist", "py-public");
      mkdirSync(pyDir, { recursive: true });
      mkdirSync(publicDir, { recursive: true });
      writeFileSync(
        join(pyDir, "pyproject.toml"),
        '[project]\nname = "mistralai-capabilities-feature-public-widget"\n',
      );
      writeFileSync(
        join(publicDir, "mistralai_capabilities_feature_public_widget-1.0.0-py3-none-any.whl"),
        "",
      );
      writeFileSync(
        join(publicDir, "mistralai_capabilities_feature_private_widget-1.0.0-py3-none-any.whl"),
        "",
      );

      expect(() =>
        selectPythonArtifacts(fixture, [
          {
            id: "public-widget",
            kind: "feature",
            packages: ["py"],
            path: "feature/public-widget",
          },
        ]),
      ).toThrow("public Python build included non-public distribution(s)");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("reports malformed packed artifact JSON and shape errors from tar members", () => {
    const fixture = mkdtempSync(join(tmpdir(), "packed-artifact-json-test-"));
    try {
      const payload = join(fixture, "payload", "package");
      mkdirSync(payload, { recursive: true });

      const malformedCapability = join(fixture, "malformed-capability.tgz");
      writeFileSync(join(payload, "capability.json"), "{ not-json\n");
      expect(
        Bun.spawnSync([
          "tar",
          "-czf",
          malformedCapability,
          "-C",
          join(fixture, "payload"),
          "package",
        ]).exitCode,
      ).toBe(0);
      expect(() => readPackedCapabilityFromArtifact(malformedCapability)).toThrow("invalid JSON");

      writeFileSync(join(payload, "capability.json"), JSON.stringify({ id: 42, kind: "base" }));
      const invalidCapabilityManifest = join(fixture, "invalid-capability-manifest.tgz");
      expect(
        Bun.spawnSync([
          "tar",
          "-czf",
          invalidCapabilityManifest,
          "-C",
          join(fixture, "payload"),
          "package",
        ]).exitCode,
      ).toBe(0);
      expect(() => readPackedCapabilityFromArtifact(invalidCapabilityManifest)).toThrow(
        "invalid capability shape",
      );

      writeFileSync(
        join(payload, "registry.json"),
        JSON.stringify({ sources: {}, kinds: [{ id: 42 }], capabilities: [] }),
      );
      const invalidDescriptorPayload = join(fixture, "invalid-descriptor-payload.tgz");
      expect(
        Bun.spawnSync([
          "tar",
          "-czf",
          invalidDescriptorPayload,
          "-C",
          join(fixture, "payload"),
          "package",
        ]).exitCode,
      ).toBe(0);
      expect(() => readPackedDescriptorFromArtifact(invalidDescriptorPayload)).toThrow(
        "invalid descriptor shape",
      );
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("rejects closure violations read from packed tarball manifests", () => {
    const fixture = mkdtempSync(join(tmpdir(), "packed-artifact-closure-test-"));
    try {
      const payload = join(fixture, "payload", "package");
      mkdirSync(payload, { recursive: true });
      writeFileSync(
        join(payload, "capability.json"),
        JSON.stringify({
          id: "core",
          kind: "base",
          metadata: { public: true },
          dependencies: ["feature/private"],
        }),
      );
      const artifact = join(fixture, "capability.tgz");
      expect(
        Bun.spawnSync(["tar", "-czf", artifact, "-C", join(fixture, "payload"), "package"])
          .exitCode,
      ).toBe(0);

      expect(() =>
        assertPackedPublicCapabilityClosure(
          readPackedCapabilityFromArtifact(artifact),
          [{ id: "core", kind: "base", packages: ["ts"], path: "base/core" }],
          "@mistralai-capabilities/base-core",
        ),
      ).toThrow("outside the public closure");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  test("rejects forbidden vendor references in any packed public capability member", async () => {
    const artifacts = mkdtempSync(join(tmpdir(), "public-vendor-policy-test-"));
    try {
      let artifact = "";
      withRepo(
        (root) => {
          writeCap(root, "feature/public-widget", {
            id: "public-widget",
            kind: "feature",
            version: "1.0.0",
            packages: ["ts"],
            metadata: { public: true },
          });
          const capability = join(root, "capabilities", "feature", "public-widget");
          mkdirSync(join(capability, "docs", "setup"), { recursive: true });
          writeFileSync(
            join(capability, "package.json"),
            JSON.stringify({ name: "@reg/feature-public-widget", version: "1.0.0" }),
          );
          writeFileSync(join(capability, "NOTICE.md"), "Install from Gemfury.\n");
          writeFileSync(
            join(capability, "docs", "setup", "registry.conf"),
            "provider=Cloudsmith\n",
          );
        },
        (root) => {
          const capability = join(root, "capabilities", "feature", "public-widget");
          const packed = Bun.spawnSync(["npm", "pack", "--pack-destination", artifacts], {
            cwd: capability,
            env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(packed.exitCode, packed.stderr.toString()).toBe(0);
          const filename = readdirSync(artifacts).find((entry) => entry.endsWith(".tgz"));
          expect(filename).toBeDefined();
          artifact = join(artifacts, filename!);
        },
      );

      const result = await scanArtifact(artifact);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          {
            artifact: expect.any(String),
            member: "package/NOTICE.md",
            part: "content",
            policy: "Gemfury reference",
          },
          {
            artifact: expect.any(String),
            member: "package/docs/setup/registry.conf",
            part: "content",
            policy: "Cloudsmith reference",
          },
        ]),
      );
    } finally {
      rmSync(artifacts, { force: true, recursive: true });
    }
  });

  test("rejects credential references in any packed public capability member", async () => {
    const artifacts = mkdtempSync(join(tmpdir(), "public-credential-policy-test-"));
    try {
      let artifact = "";
      withRepo(
        (root) => {
          writeCap(root, "feature/public-widget", {
            id: "public-widget",
            kind: "feature",
            version: "1.0.0",
            packages: ["ts"],
            metadata: { public: true },
          });
          const capability = join(root, "capabilities", "feature", "public-widget");
          const workflows = join(capability, ".github", "workflows");
          const scripts = join(capability, "scripts");
          mkdirSync(workflows, { recursive: true });
          mkdirSync(scripts, { recursive: true });
          writeFileSync(
            join(capability, "package.json"),
            JSON.stringify({ name: "@reg/feature-public-widget", version: "1.0.0" }),
          );
          writeFileSync(
            join(workflows, "ci.yml"),
            [
              "name: CI",
              "env:",
              "  UV_INDEX_SOMETHING_PASSWORD: ${{ secrets.INDEX_PASSWORD }}",
              "",
            ].join("\n"),
          );
          writeFileSync(
            join(scripts, "bootstrap.sh"),
            'export MISTRAL_REGISTRY_TOKEN="${REGISTRY_TOKEN}"\n',
          );
        },
        (root) => {
          const capability = join(root, "capabilities", "feature", "public-widget");
          const packed = Bun.spawnSync(["npm", "pack", "--pack-destination", artifacts], {
            cwd: capability,
            env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(packed.exitCode, packed.stderr.toString()).toBe(0);
          const filename = readdirSync(artifacts).find((entry) => entry.endsWith(".tgz"));
          expect(filename).toBeDefined();
          artifact = join(artifacts, filename!);
        },
      );

      const result = await scanArtifact(artifact);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          {
            artifact: expect.any(String),
            member: "package/.github/workflows/ci.yml",
            part: "content",
            policy: "uv named-index password environment variable",
          },
          {
            artifact: expect.any(String),
            member: "package/scripts/bootstrap.sh",
            part: "content",
            policy: "Mistral registry-token environment variable",
          },
        ]),
      );
    } finally {
      rmSync(artifacts, { force: true, recursive: true });
    }
  });

  test("scans member names and binary content while preserving member boundaries", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "public-artifact-policy-test-"));
    try {
      const payload = join(fixture, "payload");
      const forbiddenName = join(payload, "docs", "github.com", "mistralai", "private.md");
      mkdirSync(join(payload, "split"), { recursive: true });
      mkdirSync(join(payload, "docs", "github.com", "mistralai"), { recursive: true });
      writeFileSync(forbiddenName, "clean content");
      writeFileSync(join(payload, "split", "first.txt"), "fury");
      writeFileSync(join(payload, "split", "second.txt"), ".io");
      writeFileSync(
        join(payload, "binary.bin"),
        Buffer.concat([
          Buffer.from([0x00, 0xff, 0xfe]),
          Buffer.from("https://pypi.fury.io/mistralai/"),
        ]),
      );

      const artifact = join(fixture, "fixture.tar.gz");
      const packed = Bun.spawnSync(["tar", "-czf", artifact, "-C", payload, "."]);
      expect(packed.exitCode).toBe(0);

      const result = await scanArtifact(artifact);
      expect(result.findings).toContainEqual({
        artifact: expect.any(String),
        member: "docs/github.com/mistralai/private.md",
        part: "name",
        policy: "Mistral GitHub organization link",
      });
      expect(result.findings).toContainEqual({
        artifact: expect.any(String),
        member: "binary.bin",
        part: "content",
        policy: "Gemfury reference",
      });
      expect(
        result.findings.some(
          ({ member, policy }) => member !== "binary.bin" && policy === "Gemfury reference",
        ),
      ).toBe(false);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });
});
