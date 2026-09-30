/** Invariants for files overlaid from capability template zones into generated apps. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { unsupportedHbsExpressions } from "../support/registry-fixtures";
import { capabilities, toLocalId } from "../support/selection";
import {
  capabilityLocalIds,
  contributedPaths,
  readJson,
  REGISTRY_ROOT,
  templateDir,
  walk,
} from "../support/template-tree";

describe("template zones", () => {
  // Vendoring maps template/<rel> -> <app>/<rel> for every capability, so two capabilities that
  // contribute the same path silently overwrite each other -- and only when both are installed,
  // which is exactly the all-capabilities case.
  test("no two capabilities contribute the same file to a generated app", () => {
    const owners = new Map<string, string[]>();
    for (const id of capabilityLocalIds) {
      for (const path of contributedPaths(id)) {
        owners.set(path, [...(owners.get(path) ?? []), id]);
      }
    }
    const collisions = [...owners]
      .filter(([, ids]) => ids.length > 1)
      .map(([path, ids]) => `${path}: ${ids.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  // The CLI substitutes a `__TOKEN__` sentinel only for a chart rooted at deploy/helm/. This chart
  // is one level deeper, so a sentinel here ships verbatim into every generated app. The app name
  // now travels via .hbs and global.appName. Skill reference docs under
  // `.agents/skills/*/references/` are exempt: they document upstream API constants, so a
  // `__TOKEN__` there is a false positive.
  test("no unsubstituted __TOKEN__ sentinel survives in any template", () => {
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const root = templateDir(id);
      for (const file of walk(root)) {
        const rel = relative(root, file);
        if (/(^|\/)\.agents\/skills\/[^/]+\/references\//.test(rel)) continue;
        if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|lock)$/.test(file)) continue;
        const matches = readFileSync(file, "utf8").match(/__[A-Z][A-Z0-9_]*__/g);
        if (matches) offenders.push(`${id}/${rel}: ${[...new Set(matches)]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Handlebars renders the WHOLE file. Allow only the three constructs this registry deliberately
  // uses; a denylist for Helm prefixes missed valid Helm expressions such as
  // `{{ quote .Values.global.appName }}` and silently mangled the generated chart.
  test("every unescaped .hbs expression is in the registry's exact allowlist", () => {
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const root = templateDir(id);
      for (const file of walk(root).filter((f) => f.endsWith(".hbs"))) {
        for (const expression of unsupportedHbsExpressions(readFileSync(file, "utf8"))) {
          offenders.push(`${id}/${relative(root, file)}: ${expression}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The shell composes by file: other capabilities add routes, Vite plugins and Nx projects of
  // their own. A `.hbs` here would bring back a guard that names another capability.
  test("the tanstack-start shell ships no .hbs template", () => {
    const root = templateDir("tanstack-start");
    const templated = walk(root)
      .filter((file) => file.endsWith(".hbs"))
      .map((file) => relative(root, file));
    expect(templated).toEqual([]);
  });

  test("Handlebars guards reference only visible ordinary capabilities", () => {
    const offenders: string[] = [];
    for (const owner of capabilityLocalIds) {
      const root = templateDir(owner);
      for (const file of walk(root).filter((candidate) => candidate.endsWith(".hbs"))) {
        const source = readFileSync(file, "utf8");
        for (const [, reference] of source.matchAll(/\{\{#if \(has "([^"]+)"\)\}\}/g)) {
          const id = toLocalId(reference!);
          const guarded = capabilities.get(id);
          if (guarded?.visible === false || guarded?.activatedWhen !== undefined) {
            offenders.push(`${owner}/${relative(root, file)}: ${reference}`);
          }
        }
      }
    }

    expect(
      offenders,
      "templates must branch on visible prerequisites; hidden/derived capabilities are installation outputs",
    ).toEqual([]);
  });

  test("the .hbs allowlist rejects arbitrary helpers and Helm pipelines", () => {
    expect(
      unsupportedHbsExpressions(
        [
          "{{projectName}}",
          '{{#if (has "fastapi")}}',
          "{{/if}}",
          '{{#unless (has "fastapi")}}',
          "{{/unless}}",
          "$\\{{RUNTIME_LITERAL}}",
          "{{ quote .Values.global.appName }}",
          '{{#if (has "not-a-capability")}}',
        ].join("\n"),
      ),
    ).toEqual(["{{ quote .Values.global.appName }}", '{{#if (has "not-a-capability")}}']);
  });

  // The CLI rewrites capability dependency edges to their `.mistral/repositories/...` paths. A
  // template that hardcodes a dependency is fatal when that capability is deselected, because
  // nothing rewrites the stale line. Declare the edge in `capability.json`, not the manifest. Only
  // plain `package.json` is checked; a `.hbs` expresses this with `{{#if (has "<id>")}}`.
  test("no template package.json hardcodes a capability package dependency", () => {
    const scope = `@${readJson<{ id: string }>(join(REGISTRY_ROOT, "registry.json")).id}/`;
    const DEP_FIELDS = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const root = templateDir(id);
      for (const file of walk(root).filter((f) => f.endsWith("package.json"))) {
        const manifest = readJson<Record<string, Record<string, string> | undefined>>(file);
        for (const field of DEP_FIELDS) {
          for (const name of Object.keys(manifest[field] ?? {})) {
            if (name.startsWith(scope)) {
              offenders.push(`${id}/${relative(root, file)}: ${field}.${name}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every .hbs reference resolves to a variable the CLI provides", () => {
    const PROVIDED = new Set(["projectName"]);
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const root = templateDir(id);
      for (const file of walk(root).filter((f) => f.endsWith(".hbs"))) {
        // A `{{...}}` preceded by `\` is a Handlebars-escaped literal (it renders as `{{...}}`,
        // not a lookup), so the lookbehind drops it. A bare `${{...}}` is NOT excluded: Handlebars
        // still consumes it and blanks the value, so it must stay an offender unless it too is
        // backslash-escaped (`$\{{...}}`, as the APISIX env refs are).
        for (const [, name] of readFileSync(file, "utf8").matchAll(/(?<!\\)\{\{\s*(\w+)\s*\}\}/g)) {
          if (!PROVIDED.has(name!)) offenders.push(`${id}/${relative(root, file)}: {{${name}}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("generic workflow/tooling tests do not import feature-specific workflow modules", () => {
    const offenders: string[] = [];
    for (const [cap, rel] of [["agents", "apps/worker/tests/agents/test_tooling.py"]] as const) {
      const source = readFileSync(join(templateDir(cap), rel), "utf8");
      for (const needle of [
        "workflows.speech",
        "mistralai_capabilities.speech",
        "speech_transcribe",
        "speech_synthesize",
        "search_reconcile",
        "agent_evaluation",
        "feedback_harvest",
      ]) {
        if (source.includes(needle)) offenders.push(`${cap}/${rel}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("agents contributes its check tools to the root Python workspace", () => {
    // SAFETY: repo-owned dependency-only pyproject; malformed fields fail the assertions below. The
    // pytest + ty dev group was folded here from the former `packages/py/agents-checks` member.
    const project = Bun.TOML.parse(
      readFileSync(join(templateDir("agents"), "packages/py/agents/pyproject.toml"), "utf8"),
    ) as { "dependency-groups"?: { dev?: string[] } };
    const dependencies = project["dependency-groups"]?.dev ?? [];

    expect(dependencies.some((dependency) => dependency.startsWith("pytest"))).toBe(true);
    expect(dependencies.some((dependency) => dependency.startsWith("ty"))).toBe(true);
  });

  test("the agents target discovers every agents-owned test", () => {
    const agentsRoot = templateDir("agents");
    const project = readJson<{
      targets: { test: { options: { command: string } } };
    }>(join(agentsRoot, "apps/worker/src/worker/agents/project.json"));
    const testRoot = "apps/worker/tests/agents";
    const ownedTests = walk(join(agentsRoot, testRoot))
      .filter((file) => /\/test_[^/]+\.py$/.test(file))
      .map((file) => relative(agentsRoot, file));

    expect(ownedTests.length, "agents must own at least one test").toBeGreaterThan(0);
    expect(project.targets.test.options.command).toContain(`pytest ${testRoot}`);
  });

  test("feature-local API support modules cannot shadow shared fixtures", () => {
    const idpRoot = templateDir("document-annotation-ui");
    const testRoot = join(idpRoot, "apps/api/tests/document_annotation_ui");
    const ownedTests = walk(testRoot)
      .filter((file) => /\/test_[^/]+\.py$/.test(file))
      .map((file) => relative(idpRoot, file));

    expect(ownedTests.length, "IDP must own at least one API test").toBeGreaterThan(0);
    expect(readFileSync(join(testRoot, "__init__.py"), "utf8")).not.toBeEmpty();
    expect(readFileSync(join(testRoot, "test_workflows_route.py"), "utf8")).toContain(
      "from .support import",
    );
  });

  test("the worker manifest is static and SDK-free; the agents member owns the SDK", () => {
    // The worker manifest is owned by the workflows capability and is no longer templated -- it
    // ships an SDK-free base worker. The Agents SDK is a direct dependency of the agents
    // capability's `packages/py/agents` workspace member, so `uv sync --all-packages` installs it
    // exactly when agents is selected; a workflows-only worker stays SDK-free. `mistralai-agents` is
    // public on PyPI, so it needs no private-index source binding.
    const wfRoot = templateDir("workflows");
    expect(existsSync(join(wfRoot, "apps/worker/pyproject.toml.hbs"))).toBe(false);
    const workerManifest = readFileSync(join(wfRoot, "apps/worker/pyproject.toml"), "utf8");
    expect(workerManifest).not.toContain("mistralai-agents");

    // SAFETY: repo-owned member manifest; a shape mismatch fails the dependency assertions below.
    const agentsMember = Bun.TOML.parse(
      readFileSync(join(templateDir("agents"), "packages/py/agents/pyproject.toml"), "utf8"),
    ) as { project?: { dependencies?: string[] } };
    const deps = agentsMember.project?.dependencies ?? [];
    expect(deps.some((dependency) => dependency.startsWith("mistralai-agents=="))).toBe(true);
    expect(deps.some((dependency) => dependency.startsWith("httpx"))).toBe(true);

    const sdkImporters: string[] = [];
    for (const file of walk(wfRoot).filter((f) => f.endsWith(".py"))) {
      const moduleSource = readFileSync(file, "utf8");
      if (
        moduleSource.includes("mistralai.agents") ||
        moduleSource.includes("plugins.mistralai.connectors")
      ) {
        sdkImporters.push(relative(wfRoot, file));
      }
    }
    expect(sdkImporters).toEqual([]);
  });

  test("the Agents SDK pin is identical in the member and the agent project", () => {
    // These two declarants must stay in lockstep (the capability-agents SKILL documents this): the
    // member injects the SDK into the shared env via `uv sync --all-packages`, while the non-member
    // agent project declares its own import against that same env. A skew would let the agent
    // project's checks run a different SDK version than the worker actually installs.
    const agentsRoot = templateDir("agents");
    const sdkPinIn = (rel: string): string => {
      // SAFETY: repo-owned member manifest; a shape mismatch fails the assertion below.
      const parsed = Bun.TOML.parse(readFileSync(join(agentsRoot, rel), "utf8")) as {
        project?: { dependencies?: string[] };
      };
      const pin = (parsed.project?.dependencies ?? []).find((dependency) =>
        dependency.startsWith("mistralai-agents=="),
      );
      expect(pin, `${rel} must pin mistralai-agents exactly`).toBeDefined();
      return pin!;
    };
    expect(sdkPinIn("packages/py/agents/pyproject.toml")).toBe(
      sdkPinIn("apps/worker/src/worker/agents/pyproject.toml"),
    );
  });

  test("worker health probes use the SDK health server, not feature imports or marker files", () => {
    const dockerfile = readFileSync(
      join(templateDir("workflows"), "deploy", "docker", "Dockerfile.worker"),
      "utf8",
    );
    const compose = readFileSync(
      join(
        templateDir("docker-compose-workflows"),
        "deploy",
        "compose",
        "compose.workflows.yaml.hbs",
      ),
      "utf8",
    );
    for (const [label, source] of [
      ["Dockerfile.worker", dockerfile],
      ["compose.workflows.yaml", compose],
    ] as const) {
      const staleMarker = ["/tmp", ["workflows", "ready"].join("-")].join("/");
      expect(source, `${label} should not import a capability toolkit for health`).not.toContain(
        "mistralai_capabilities",
      );
      expect(source, `${label} should not use a marker file for health`).not.toContain(staleMarker);
      expect(source, `${label} should set the SDK health server host`).toContain(
        "HEALTH_SERVER_HOST",
      );
      expect(source, `${label} should enable the SDK health server`).toContain(
        "HEALTH_SERVER_PORT",
      );
      expect(source, `${label} should probe the loopback health server`).toContain(
        "127.0.0.1:3001",
      );
      expect(source, `${label} should probe the SDK health endpoint`).toContain("/health");
    }
  });
});
