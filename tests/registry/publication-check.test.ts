import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  checkPublicationGraph as checkPublicationGraphForRegistry,
  type PublicationFinding,
  type PublicationFindingCode,
  validatedPublicCapabilities,
} from "../../scripts/registry/publication-check";
import {
  type CapabilityManifest,
  type JsonValue,
  readManifests,
} from "../../scripts/shared/manifests";
import { withRepo } from "./support/registry-fixture";
import { REGISTRY_ROOT } from "./support/template-tree";

const SCRIPT = join(REGISTRY_ROOT, "scripts", "registry", "publication-check.ts");

const writeJson = (path: string, value: JsonValue): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const runPublicationCheck = (root: string) => {
  const proc = Bun.spawnSync(["bun", SCRIPT], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
};

const capability = (
  id: string,
  isPublic: boolean,
  dependencies?: string[],
  kind = "feature",
): CapabilityManifest => ({
  id,
  version: "1.0.0",
  kind,
  path: `${kind}/${id}`,
  dependencies,
  packages: ["ts"],
  metadata: { public: isPublic },
});

const checkPublicationGraph = (manifests: readonly CapabilityManifest[]) =>
  checkPublicationGraphForRegistry(manifests, "reg", "capabilities");

const findingCodes = (manifests: readonly CapabilityManifest[]): PublicationFindingCode[] =>
  checkPublicationGraph(manifests).findings.map(({ code }) => code);

describe("publication eligibility", () => {
  test("release selection fails closed on the same graph findings as the hard gate", () => {
    const manifests = [capability("public", true, ["private"]), capability("private", false)];
    expect(() => validatedPublicCapabilities(manifests, "reg", "capabilities")).toThrow(
      "public capability eligibility failed",
    );
    expect(
      validatedPublicCapabilities(
        [capability("public", true), capability("private", false)],
        "reg",
        "capabilities",
      ).map(({ id }) => id),
    ).toEqual(["public"]);
  });

  test("reports each non-public capability in the public dependency closure once", () => {
    const direct = checkPublicationGraph([capability("a", true, ["b"]), capability("b", false)]);
    expect(direct.findings).toEqual([
      expect.objectContaining({ code: "private-dependency", capabilityId: "feature/b" }),
    ]);

    const transitive = checkPublicationGraph([
      capability("a", true, ["b"]),
      capability("b", true, ["c"]),
      capability("c", false),
    ]);
    expect(transitive.findings).toEqual([
      expect.objectContaining({ code: "private-dependency", capabilityId: "feature/c" }),
    ]);

    const diamond = checkPublicationGraph([
      capability("a", true, ["b", "c"]),
      capability("b", true, ["d"]),
      capability("c", true, ["d"]),
      capability("d", false),
    ]);
    expect(diamond.findings).toEqual([
      expect.objectContaining({ code: "private-dependency", capabilityId: "feature/d" }),
    ]);
  });

  test("resolves kind-qualified dependencies when leaf ids are duplicated", () => {
    const result = checkPublicationGraph([
      capability("chat", true, ["base/search"]),
      capability("search", false, undefined, "base"),
      capability("search", true, undefined, "frontend"),
    ]);

    expect(result.findings).toEqual([
      expect.objectContaining({ code: "private-dependency", capabilityId: "base/search" }),
    ]);
  });

  test("accepts absent and empty dependency lists and an all-public transitive closure", () => {
    for (const manifests of [
      [capability("a", true)],
      [capability("a", true, [])],
      [capability("a", true, ["b"]), capability("b", true, ["a"])],
      [capability("a", true, ["b"]), capability("b", true, ["c"]), capability("c", true, [])],
    ]) {
      expect(checkPublicationGraph(manifests).findings).toEqual([]);
    }
  });

  test("hard-fails a public capability with an absent or empty package list", () => {
    for (const manifest of [
      {
        id: "packages-absent",
        version: "1.0.0",
        kind: "feature",
        path: "feature/packages-absent",
        metadata: { public: true },
      },
      {
        id: "packages-empty",
        version: "1.0.0",
        kind: "feature",
        path: "feature/packages-empty",
        packages: [],
        metadata: { public: true },
      },
    ]) {
      const result = checkPublicationGraph([manifest]);
      expect(result.findings).toEqual([
        expect.objectContaining({
          code: "template-only-public",
          capabilityId: `${manifest.kind}/${manifest.id}`,
          message: expect.stringContaining("private source repository"),
        }),
      ]);
    }
  });

  test("checks core's canonical template/package.json directly (no public overlay file)", () => {
    withRepo(
      (root) => {
        const core = join(root, "capabilities", "base", "core");
        writeJson(join(core, "package.json"), { name: "@reg/base-core" });
        writeJson(join(core, "template", "package.json"), {
          name: "canonical-app",
          overrides: { "@mistralai/ui": "64.1.1", react: "19.0.0" },
        });
      },
      (root) => {
        const core = {
          ...capability("core", true, undefined, "base"),
          metadata: { public: true, registryPins: ["package.json"] },
        };
        const safe = checkPublicationGraphForRegistry([core], "reg", "capabilities", root);
        expect(safe.findings.filter(({ code }) => code === "private-npm-dependency")).toEqual([]);

        // The exemption must work at both gates: the projector keeps this real dependency,
        // and the public npm name allowlist approves its normal public-registry specifier.
        writeJson(join(root, "capabilities", "base", "core", "template", "package.json"), {
          name: "canonical-app",
          dependencies: { "@mistralai/mistralai": "^2" },
        });
        const exempt = checkPublicationGraphForRegistry([core], "reg", "capabilities", root);
        expect(exempt.findings.filter(({ code }) => code === "private-npm-dependency")).toEqual([]);

        writeJson(join(root, "capabilities", "base", "core", "template", "package.json"), {
          name: "canonical-app",
          dependencies: { "@mistralai/ui": "64.1.1" },
        });
        const unsafe = checkPublicationGraphForRegistry([core], "reg", "capabilities", root);
        expect(unsafe.findings).toEqual([
          expect.objectContaining({
            code: "private-npm-dependency",
            message: expect.stringContaining("template/package.json"),
          }),
        ]);
      },
    );
  });

  test("fails closed when a public npm package or bun catalog names an unapproved package", () => {
    withRepo(
      (root) => {
        writeJson(join(root, "registry.config.json"), { id: "reg" });
        const capabilityRoot = join(root, "capabilities", "feature", "unsafe");
        writeJson(join(capabilityRoot, "capability.json"), {
          id: "unsafe",
          version: "1.0.0",
          kind: "feature",
          packages: ["ts"],
          metadata: { public: true },
        });
        writeJson(join(capabilityRoot, "package.json"), {
          name: "@reg/feature-unsafe",
          dependencies: {
            "@reg/vendored": "workspace:*",
            "local-fixture": "file:./vendor/local-fixture",
            react: "^19",
          },
          workspaces: {
            catalog: {
              "@private/squat-target": "1.2.3",
            },
          },
        });
      },
      (root) => {
        const result = runPublicationCheck(root);
        expect(result.exitCode, result.output).toBe(1);
        expect(result.output).toContain("[private-npm-dependency]");
        expect(result.output).toContain("@private/squat-target@1.2.3");
        expect(result.output).not.toContain("@reg/vendored");
        expect(result.output).not.toContain("local-fixture");
        expect(result.output).not.toContain("react@^19");
      },
    );
  });

  test("the npm gate rejects private-scope dependencies from every checked section", () => {
    const sections = [
      [
        "dependencies",
        { "@mistralai/private-dependency": "1.0.0" },
        "@mistralai/private-dependency@1.0.0",
      ],
      [
        "devDependencies",
        { "@mistral/private-dev-dependency": "1.0.0" },
        "@mistral/private-dev-dependency@1.0.0",
      ],
      [
        "optionalDependencies",
        { "@mistralai/private-optional": "1.0.0" },
        "@mistralai/private-optional@1.0.0",
      ],
      ["peerDependencies", { "@mistral/private-peer": "1.0.0" }, "@mistral/private-peer@1.0.0"],
      [
        "workspaces",
        { catalog: { "@mistralai/private-catalog": "1.0.0" } },
        "@mistralai/private-catalog@1.0.0",
      ],
    ] as const;

    for (const [section, value, expectedEntry] of sections) {
      let messages = "";
      withRepo(
        (root) => {
          writeJson(join(root, "capabilities", "base", "core", "template", "package.json"), {
            name: "canonical-app",
            [section]: value,
          });
        },
        (root) => {
          messages = checkPublicationGraphForRegistry(
            [capability("core", true, undefined, "base")],
            "reg",
            "capabilities",
            root,
          )
            .findings.filter(({ code }) => code === "private-npm-dependency")
            .map(({ message }) => message)
            .join("\n");
        },
      );
      // Exact diagnostic, not just a private-scope substring: the offending name AND specifier the
      // gate actually found, so a future regression that reports the wrong entry (or the right name
      // with a mangled version) fails here instead of passing on a loose "@mistral" match.
      expect(messages, section).toContain(expectedEntry);
    }
  });

  // A gated package manifest is rendered with every gate on before it is parsed, so the dependency
  // inside a gate is scanned like any other. A gate this renderer cannot read leaves `{{` behind
  // and the manifest is reported as uncheckable rather than passed.
  const gatedManifestMessages = (gate: string): string => {
    let messages = "";
    withRepo(
      (root) => {
        const path = join(
          root,
          "capabilities",
          "feature",
          "unsafe",
          "template",
          "package.json.hbs",
        );
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(
          path,
          `{\n  "name": "@reg/feature-unsafe",\n  "dependencies": {\n    ${gate}\n    "@private/gated": "1.2.3"\n    {{/if}}\n  }\n}\n`,
        );
      },
      (root) => {
        messages = checkPublicationGraphForRegistry(
          [capability("unsafe", true)],
          "reg",
          "capabilities",
          root,
        )
          .findings.filter(({ code }) => code === "private-npm-dependency")
          .map(({ message }) => message)
          .join("\n");
      },
    );
    return messages;
  };

  test.each(['{{#if (has "open")}}', '{{#if ( has "open" )}}', '{{#if   (  has   "open"  )  }}'])(
    "the npm gate reads a dependency gated by %p",
    (gate) => {
      expect(gatedManifestMessages(gate)).toContain("@private/gated@1.2.3");
    },
  );

  test.each(['{{#if (missing "open")}}', "{{#each capabilities}}"])(
    "the npm gate reports a manifest it cannot render at %p",
    (gate) => {
      expect(gatedManifestMessages(gate)).toContain("cannot be checked for public npm safety");
    },
  );

  // The allowlist reviews a name, so the specifier still has to resolve from registry.npmjs.org.
  const allowlistedSpecifier = (specifier: string): string => {
    let messages = "";
    withRepo(
      (root) => {
        writeJson(join(root, "capabilities", "feature", "unsafe", "package.json"), {
          name: "@reg/feature-unsafe",
          dependencies: { react: specifier },
          workspaces: { catalog: { react: "^19" } },
        });
      },
      (root) => {
        messages = checkPublicationGraphForRegistry(
          [capability("unsafe", true)],
          "reg",
          "capabilities",
          root,
        )
          .findings.filter(({ code }) => code === "private-npm-dependency")
          .map(({ message }) => message)
          .join("\n");
      },
    );
    return messages;
  };

  test.each(["^19", "19.2.17", "*", "latest", "catalog:"])(
    "the npm gate accepts an allowlisted name at %p",
    (specifier) => {
      expect(allowlistedSpecifier(specifier)).toBe("");
    },
  );

  test.each([
    "git+ssh://git@github.com/acme/react.git",
    "https://example.invalid/react.tgz",
    "npm:@private/react@1.0.0",
  ])("the npm gate rejects an allowlisted name at %p", (specifier) => {
    expect(allowlistedSpecifier(specifier)).toContain(`react@${specifier}`);
  });

  // Handlebars is not rendered at publication time, so a gate reaches the tarball with the
  // capability id it names. The fixture offers a public `open` and a private `closed` to gate on.
  const templateGateMessages = (body: string, file = "app.ts.hbs"): string => {
    let messages = "";
    withRepo(
      (root) => {
        const path = join(root, "capabilities", "feature", "consumer", file);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, `// first line\n${body}\n`);
      },
      (root) => {
        messages = checkPublicationGraphForRegistry(
          [capability("consumer", true), capability("open", true), capability("closed", false)],
          "reg",
          "capabilities",
          root,
        )
          .findings.filter(({ code }) => code === "private-template-gate")
          .map(({ message }) => message)
          .join("\n");
      },
    );
    return messages;
  };

  test.each([
    "nothing gated at all",
    '{{#if (has "open")}}x{{/if}}',
    '{{#if (has "feature/open")}}x{{/if}}',
    '{{#if (has "reg/feature/open")}}x{{/if}}',
    '{{#unless (has "open")}}x{{/unless}}',
    '{{#if ( has "open" )}}x{{/if}}',
    '{{#if (  has   "reg/feature/open"  )}}x{{/if}}',
  ])("the template gate accepts %p", (body) => {
    expect(templateGateMessages(body, join("template", "app.ts.hbs"))).toBe("");
  });

  test.each([
    { body: '{{#if (has "closed")}}x{{/if}}', expected: "the private capability feature/closed" },
    {
      body: '{{#if (has "feature/closed")}}x{{/if}}',
      expected: "the private capability feature/closed",
    },
    { body: '{{#if (has "absent")}}x{{/if}}', expected: "cannot be resolved" },
    { body: '{{#if (has "other/feature/open")}}x{{/if}}', expected: "belongs to another registry" },
    { body: "{{#if (has open)}}x{{/if}}", expected: "unreadable gate expression `(has open)`" },
    { body: "{{#if (has)}}x{{/if}}", expected: "unreadable gate expression `(has)`" },
    // Handlebars ignores the spaces, so these are the same gates as the unspaced ones above.
    {
      body: '{{#if ( has "closed" )}}x{{/if}}',
      expected: "the private capability feature/closed",
    },
    {
      body: '{{#unless (\n  has\n  "feature/closed"\n)}}x{{/unless}}',
      expected: "the private capability feature/closed",
    },
    { body: '{{#if ( has "absent" )}}x{{/if}}', expected: "cannot be resolved" },
    { body: "{{#if ( has open )}}x{{/if}}", expected: "unreadable gate expression `( has open )`" },
  ])("the template gate rejects $body", ({ body, expected }) => {
    const messages = templateGateMessages(body, join("template", "app.ts.hbs"));
    expect(messages).toContain(expected);
    expect(messages).toContain(`${join("template", "app.ts.hbs")}:2`);
  });

  // Only the template ships to a consumer. A gate named in the capability's own changelog or
  // source is not a published one.
  test.each(["CHANGELOG.md", join("package", "ts", "index.ts")])(
    "the template gate ignores %p outside the template",
    (file) => {
      expect(templateGateMessages('{{#if (has "closed")}}x{{/if}}', file)).toBe("");
    },
  );

  // The CLI renders `.hbs` and copies the rest across untouched, so `(has ...)` in a Helm chart or
  // a shell script is that language's own syntax and publishes nothing. Helm's sprig has a `has`.
  test.each([
    join("template", "deploy", "helm", "app", "templates", "job.yaml"),
    join("template", "tools", "up.sh"),
  ])("the template gate ignores %p, which the CLI never renders", (file) => {
    expect(templateGateMessages('{{ if (has "closed" .Values.parts) }}x{{ end }}', file)).toBe("");
  });

  test("the template gate names every private gate in a public docker-compose projection", () => {
    const manifests = readManifests(REGISTRY_ROOT).map((manifest) =>
      manifest.kind === "deployment" && manifest.id === "docker-compose"
        ? { ...manifest, metadata: { ...manifest.metadata, public: true } }
        : manifest,
    );
    const finding = checkPublicationGraphForRegistry(
      manifests,
      "mistralai-capabilities",
      "capabilities",
      REGISTRY_ROOT,
    ).findings.find(({ code }) => code === "private-template-gate");

    expect(finding?.capabilityId).toBe("deployment/docker-compose");
    for (const gated of [
      "feature/agents",
      "feature/auth",
      "feature/chat",
      "feature/evals",
      "backend/fastapi",
      "feature/guardrailing",
      "feature/mcp-apps",
      "database/postgres",
      "database/bucket",
      "frontend/tanstack-start",
      "backend/workflows",
    ]) {
      expect(finding?.message).toContain(`the private capability ${gated}`);
    }
  });

  test("fails closed when a public Python package declares or binds to the private index", () => {
    withRepo(
      (root) => {
        writeJson(join(root, "registry.config.json"), { id: "reg" });
        writeJson(join(root, "capabilities", "feature", "unsafe", "capability.json"), {
          id: "unsafe",
          version: "1.0.0",
          kind: "feature",
          packages: ["py"],
          metadata: { public: true },
        });
        const pyproject = join(
          root,
          "capabilities",
          "feature",
          "unsafe",
          "package",
          "py",
          "pyproject.toml",
        );
        mkdirSync(join(pyproject, ".."), { recursive: true });
        writeFileSync(
          pyproject,
          '[project]\nname = "reg-feature-unsafe"\nversion = "1.0.0"\n' +
            '[tool.uv.sources]\nprivate-dependency = { index = "mistralai" }\n' +
            '[[tool.uv.index]]\nname = "mistralai"\nurl = "https://example.invalid/simple"\n',
        );
      },
      (root) => {
        const result = runPublicationCheck(root);
        expect(result.exitCode, result.output).toBe(1);
        expect(result.output).toContain("[private-python-index]");
        expect(result.output).toContain("source bindings: private-dependency");
      },
    );
  });

  test("rejects uv scalar index settings that target an internal registry", () => {
    withRepo(
      (root) => {
        writeJson(join(root, "registry.config.json"), { id: "reg" });
        writeJson(join(root, "capabilities", "feature", "unsafe", "capability.json"), {
          id: "unsafe",
          version: "1.0.0",
          kind: "feature",
          packages: ["py"],
          metadata: { public: true },
        });
        const pyproject = join(
          root,
          "capabilities",
          "feature",
          "unsafe",
          "package",
          "py",
          "pyproject.toml",
        );
        mkdirSync(join(pyproject, ".."), { recursive: true });
        writeFileSync(
          pyproject,
          '[project]\nname = "reg-feature-unsafe"\nversion = "1.0.0"\n\n' +
            '[tool.uv]\nindex-url = "https://pypi.fury.io/mistralai/"\n',
        );
      },
      (root) => {
        const result = runPublicationCheck(root);
        expect(result.exitCode, result.output).toBe(1);
        expect(result.output).toContain("[private-python-index]");
        expect(result.output).toContain("tool.uv.index-url");
        expect(result.output).toContain("https://pypi.fury.io/mistralai/");
      },
    );
  });

  test("allows a public Python package to retain an explicit pypi source binding", () => {
    withRepo(
      (root) => {
        writeJson(join(root, "registry.config.json"), { id: "reg" });
        writeJson(join(root, "capabilities", "feature", "safe", "capability.json"), {
          id: "safe",
          version: "1.0.0",
          kind: "feature",
          packages: ["py"],
          metadata: { public: true },
        });
        const pyproject = join(
          root,
          "capabilities",
          "feature",
          "safe",
          "package",
          "py",
          "pyproject.toml",
        );
        mkdirSync(join(pyproject, ".."), { recursive: true });
        writeFileSync(
          pyproject,
          '[project]\nname = "reg-feature-safe"\nversion = "1.0.0"\n' +
            '[tool.uv.sources]\npublic-dependency = { index = "pypi" }\n' +
            '[[tool.uv.index]]\nname = "pypi"\nurl = "https://pypi.org/simple"\n',
        );
      },
      (root) => {
        const result = runPublicationCheck(root);
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).not.toContain("private-python-index");
      },
    );
  });

  const pythonIndexFindings = (sources: string, indexUrl = "https://pypi.org/simple"): string => {
    let messages = "";
    withRepo(
      (root) => {
        const pyproject = join(
          root,
          "capabilities",
          "feature",
          "unsafe",
          "package",
          "py",
          "pyproject.toml",
        );
        mkdirSync(join(pyproject, ".."), { recursive: true });
        writeFileSync(
          pyproject,
          '[project]\nname = "reg-feature-unsafe"\nversion = "1.0.0"\n' +
            `[tool.uv.sources]\n${sources}\n` +
            `[[tool.uv.index]]\nname = "pypi"\nurl = "${indexUrl}"\n`,
        );
      },
      (root) => {
        messages = checkPublicationGraphForRegistry(
          [{ ...capability("unsafe", true), packages: ["py"] }],
          "reg",
          "capabilities",
          root,
        )
          .findings.filter(({ code }) => code === "private-python-index")
          .map(({ message }) => message)
          .join("\n");
      },
    );
    return messages;
  };

  test.each(["https://pypi.org/simple", "https://pypi.org/simple/"])(
    "the Python gate accepts the public index at %p",
    (indexUrl) => {
      expect(pythonIndexFindings('dep = { index = "pypi" }', indexUrl)).toBe("");
    },
  );

  // A credentialed or query-bearing URL matches on protocol, host and path, so the endpoint check
  // has to reject it separately or the userinfo ships in the published pyproject.
  test.each([
    "https://user:secret@pypi.org/simple",
    "https://pypi.org/simple?token=secret",
    "https://pypi.org/simple#secret",
  ])("the Python gate rejects a public index URL carrying %p", (indexUrl) => {
    expect(pythonIndexFindings('dep = { index = "pypi" }', indexUrl)).toContain("index: pypi");
  });

  test.each([
    'dep = { index = "pypi" }',
    "dep = { workspace = true }",
    'dep = { index = "pypi", marker = "sys_platform == \'linux\'" }',
    'dep = { workspace = true, extra = "gpu" }',
    'dep = { index = "pypi", group = "dev" }',
  ])("the Python gate accepts the source shape %p", (sources) => {
    expect(pythonIndexFindings(sources)).toBe("");
  });

  // An absent `index` key is not evidence a source is safe: uv still fetches these.
  test.each([
    'dep = { url = "https://internal.example/dep.whl" }',
    'dep = { git = "ssh://git@example.invalid/dep.git" }',
    'dep = { path = "../vendor/dep" }',
    'dep = { index = "mistralai" }',
    'dep = { index = "pypi", url = "https://internal.example/dep.whl" }',
    'dep = { index = "pypi", path = "../vendor/dep" }',
    "dep = { marker = \"sys_platform == 'linux'\" }",
    "dep = { workspace = false }",
    "dep = {}",
  ])("the Python gate rejects the source shape %p", (sources) => {
    expect(pythonIndexFindings(sources)).toContain("source bindings: dep");
  });

  test("reports every unknown dependency declarer deterministically", () => {
    const externalRef = "external-registry/feature/missing";
    const manifests = [
      capability("zeta", true, ["missing", externalRef, "missing", externalRef]),
      capability("alpha", true, [externalRef, "missing"]),
    ];
    const expectedFindings: PublicationFinding[] = [
      {
        code: "unknown-dependency",
        capabilityId: "missing",
        message:
          'capabilities "feature/alpha", "feature/zeta" declare capability reference "missing", which is reachable from a public capability but cannot be resolved: unknown capability reference `missing`; known: reg/feature/alpha, reg/feature/zeta.',
      },
      {
        code: "unknown-dependency",
        capabilityId: externalRef,
        message:
          'capability "external-registry/feature/missing" is reachable from a public capability but has no capability manifest; the dependency is declared by capabilities "feature/alpha", "feature/zeta".',
      },
    ];

    const findings = checkPublicationGraph(manifests).findings;
    expect(findings).toEqual(expectedFindings);
    expect(findings.map(({ message }) => message).join("\n")).not.toContain("undefined");

    const reorderedFindings = checkPublicationGraph(
      manifests.toReversed().map((manifest) => ({
        ...manifest,
        dependencies: manifest.dependencies?.toReversed(),
      })),
    ).findings;
    expect(reorderedFindings).toEqual(expectedFindings);
  });

  test("the real checker scans a configured non-default capabilitiesDir", () => {
    withRepo(
      (root) => {
        writeJson(join(root, "registry.config.json"), {
          id: "reg",
          capabilitiesDir: "catalog",
        });
        writeJson(join(root, "catalog", "feature", "published", "capability.json"), {
          id: "published",
          version: "1.0.0",
          kind: "feature",
          packages: ["ts"],
          metadata: { public: true },
        });
      },
      (root) => {
        const result = runPublicationCheck(root);
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).toContain("Public capabilities: feature/published");
      },
    );
  });

  test("diagnostics use the configured non-default capabilitiesDir", () => {
    withRepo(
      (root) => {
        writeJson(join(root, "registry.config.json"), {
          id: "reg",
          capabilitiesDir: "catalog",
        });
        writeJson(join(root, "catalog", "feature", "implicit", "capability.json"), {
          id: "implicit",
          version: "1.0.0",
          kind: "feature",
          packages: ["ts"],
        });
        writeJson(join(root, "catalog", "feature", "private", "capability.json"), {
          id: "private",
          version: "1.0.0",
          kind: "feature",
          packages: ["ts"],
          metadata: { public: false },
        });
        writeJson(join(root, "catalog", "feature", "published", "capability.json"), {
          id: "published",
          version: "1.0.0",
          kind: "feature",
          dependencies: ["private"],
          packages: ["ts"],
          metadata: { public: true },
        });
        writeJson(join(root, "catalog", "feature", "template-only", "capability.json"), {
          id: "template-only",
          version: "1.0.0",
          kind: "feature",
          metadata: { public: true },
        });
      },
      (root) => {
        const result = runPublicationCheck(root);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(
          "[invalid-public-flag] catalog/feature/implicit/capability.json must explicitly declare",
        );
        expect(result.output).toContain(
          '[template-only-public] public capability "feature/template-only" declares no package languages and is template-only; external consumers cannot install it without sources.git, which points at the private source repository (catalog/feature/template-only/capability.json).',
        );
        expect(result.output).toContain(
          "[private-dependency] catalog/feature/private/capability.json is reachable from a public capability but is not public",
        );
        expect(result.output).not.toContain("capabilities/feature/");
      },
    );
  });

  test("the real checker rejects a missing, empty, or non-string registry id", () => {
    const invalidConfigs: JsonValue[] = [{}, { id: "" }, { id: 42 }];
    for (const config of invalidConfigs) {
      withRepo(
        (root) => writeJson(join(root, "registry.config.json"), config),
        (root) => {
          const result = runPublicationCheck(root);
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain("must declare `id` as a non-empty string");
        },
      );
    }
  });

  test("the real checker rejects an empty or non-string capabilitiesDir", () => {
    for (const capabilitiesDir of ["", 42]) {
      withRepo(
        (root) =>
          writeJson(join(root, "registry.config.json"), {
            id: "reg",
            capabilitiesDir,
          }),
        (root) => {
          const result = runPublicationCheck(root);
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain(
            "must declare `capabilitiesDir` as a non-empty string when present",
          );
        },
      );
    }
  });

  test("requires every first-party manifest to explicitly author a boolean", () => {
    const absent: CapabilityManifest = {
      id: "implicit-private",
      version: "1.0.0",
      kind: "feature",
      path: "feature/implicit-private",
    };
    const invalid: CapabilityManifest = {
      id: "stringly-public",
      version: "1.0.0",
      kind: "feature",
      path: "feature/stringly-public",
      packages: ["ts"],
      metadata: { public: "true" },
    };

    expect(checkPublicationGraph([absent]).publicCapabilityIds).toEqual([]);
    expect(findingCodes([absent])).toEqual(["invalid-public-flag"]);
    expect(checkPublicationGraph([invalid]).publicCapabilityIds).toEqual([]);
    expect(findingCodes([invalid])).toEqual(["invalid-public-flag"]);
  });

  // Passes the repo root explicitly: without it the npm and Python index gates skip every
  // capability, so the catalogue would stay green no matter what a public manifest declared.
  test("the repository catalogue is green without network", () => {
    expect(
      checkPublicationGraphForRegistry(
        readManifests(REGISTRY_ROOT),
        "reg",
        "capabilities",
        REGISTRY_ROOT,
      ).findings,
    ).toEqual([]);
  });
});

const readRepoFile = (...segments: string[]): string =>
  readFileSync(join(REGISTRY_ROOT, ...segments), "utf8");

// The skills are hard-wrapped prose, so a phrase asserted below can straddle a line break.
// Collapsing whitespace lets an author rewrap a paragraph without failing the build.
const unwrapped = (...segments: string[]): string =>
  readRepoFile(...segments).replaceAll(/\s+/g, " ");

// The gate only helps if an author meets it before their first `registry:check`, and the two
// authoring skills are where they look. Asserting the prose is the same tier the repository already
// uses for the README capability table.
describe("the authoring skills describe the publication gate", () => {
  const GATE_SCRIPTS = [
    "publication-check.ts",
    "build-registry.ts --check",
    "app-registry-pins.ts --check",
  ];

  const registryMd = unwrapped("skills", "contribute-capabilities", "REGISTRY.md");
  const skillMd = unwrapped("skills", "write-mistral-apps-capability", "SKILL.md");

  test("registry:check runs the three documented scripts in order", () => {
    // SAFETY: the repository's own package.json.
    const command = (
      JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> }
    ).scripts["registry:check"];
    const positions = GATE_SCRIPTS.map((script) => command?.indexOf(script) ?? -1);
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });

  test.each(GATE_SCRIPTS)("REGISTRY.md names %s", (script) => {
    expect(registryMd).toContain(script);
  });

  test.each([
    { doc: "REGISTRY.md", source: registryMd },
    { doc: "SKILL.md", source: skillMd },
  ])("$doc states that metadata.public is explicit and false unless publishing", ({ source }) => {
    expect(source).toContain("metadata.public");
    expect(source).toContain("false");
    expect(source).toContain("unless");
  });

  test("REGISTRY.md describes the dependency checks the gate actually runs", () => {
    expect(registryMd.toLowerCase()).toContain("allowlist");
    expect(registryMd).toContain("pypi");
    // An allowlisted name still fails behind a git or tarball specifier, so the specifier shapes
    // have to be on the page too.
    expect(registryMd).toContain("catalog:");
    // A workspace binding is the other accepted source, and omitting it reads as a ban on it.
    // `workspace` appears elsewhere too, so this has to land where `[tool.uv.sources]` is described.
    expect(registryMd).toMatch(/tool\.uv\.sources[\s\S]{0,160}?workspace/);
  });

  // REGISTRY.md is the single home of the gate; the authoring skill reaches it through a link, so
  // the link is what an author depends on.
  test("SKILL.md links to the gate section of REGISTRY.md", () => {
    const link = /\]\((\.\.\/[^)#\s]+REGISTRY\.md)#the-gate\)/.exec(skillMd)?.[1];
    expect(link).toBeDefined();
    const skillDir = join(REGISTRY_ROOT, "skills", "write-mistral-apps-capability");
    expect(existsSync(join(skillDir, link ?? ""))).toBe(true);
    expect(readRepoFile("skills", "contribute-capabilities", "REGISTRY.md")).toMatch(
      /^## The gate$/m,
    );
  });

  test("SKILL.md identifies the registry it governs, not the archived one", () => {
    expect(skillMd).toContain("`mistralai-capabilities` registry");
    expect(skillMd).not.toContain("solutions-capabilities");
  });

  // The gate resolves nothing: npm is a static name allowlist and the Python half only reads
  // `[tool.uv]`. A doc promising index resolution sends an author off to check the wrong thing.
  test("REGISTRY.md does not claim the gate resolves dependencies on an index", () => {
    expect(registryMd).not.toContain("resolve on the public indexes");
  });
});
