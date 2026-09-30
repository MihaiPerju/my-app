/**
 * A freshly generated app must pass its own quality gates before anyone adds code to it.
 *
 * Each case below was found by building apps on this registry: `bun run check` failed on the
 * pristine scaffold, so every app had to work around the template before it could run its own gate.
 * These assertions read the committed templates (and run the committed shell where the behaviour is
 * the contract), so the same regressions fail here on every PR rather than in a generated app.
 * The e2e (`scripts/e2e/generate_app.py`) runs the real linters and coverage gates on top.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { renderHbs } from "../support/selection";
import {
  CAPABILITIES_DIR,
  capabilityLocalIds,
  contributedPaths,
  templateDir,
  walk,
} from "../support/template-tree";

const templateFiles = walk(CAPABILITIES_DIR).filter((path) =>
  relative(CAPABILITIES_DIR, path).split("/").includes("template"),
);
const shellScripts = templateFiles.filter((path) => /\.sh(\.hbs)?$/.test(path));
const dockerfiles = templateFiles.filter((path) => /\/Dockerfile[^/]*$/.test(path));
const rel = (path: string) => relative(CAPABILITIES_DIR, path);

/** A Dockerfile's instructions, with `\` line continuations joined into one logical line each. */
const logicalLines = (text: string): string[] => text.replace(/\\\n/g, " ").split("\n");

describe("quality:lint-shell passes on the template's own scripts", () => {
  test("every shell script names its dialect (SC2148)", () => {
    // A sourced fragment such as tools/lib.sh has no shebang on purpose; it must carry a
    // `# shellcheck shell=` directive instead, or shellcheck reports SC2148 as an error.
    expect(shellScripts.length).toBeGreaterThan(0);
    const unknown = shellScripts.filter((path) => {
      const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
      return !first.startsWith("#!") && !/^# shellcheck shell=\w+/.test(first);
    });
    expect(unknown.map(rel)).toEqual([]);
  });

  test("scripts that source a sibling are resolvable by shellcheck (SC1091)", () => {
    // `. "${0%/*}/lib.sh"` cannot be evaluated statically; the shipped .shellcheckrc points
    // shellcheck at the script's own directory.
    const sourcing = shellScripts.filter((path) =>
      readFileSync(path, "utf8").includes('. "${0%/*}/'),
    );
    expect(sourcing.length).toBeGreaterThan(0);
    const rc = readFileSync(join(templateDir("code-quality"), ".shellcheckrc"), "utf8");
    expect(rc).toMatch(/^source-path=SCRIPTDIR$/m);
  });
});

describe("quality:lint-docker passes on the template's own Dockerfiles", () => {
  test("no RUN exports a command substitution in the same statement (SC2155)", () => {
    const offenders = dockerfiles.flatMap((path) =>
      logicalLines(readFileSync(path, "utf8"))
        .filter((line) => /\bexport\b[^;&|]*=["']?\$\(/.test(line))
        .map((line) => `${rel(path)}: ${line.trim().slice(0, 120)}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the hadolint policy is committed and actually read", () => {
    const policy = readFileSync(join(templateDir("code-quality"), ".hadolint.yaml"), "utf8");
    // SAFETY: repo-owned YAML; a missing `ignored` list fails the assertion below.
    const parsed = Bun.YAML.parse(policy) as { ignored?: string[] };
    expect(parsed.ignored).toEqual(["DL3008"]);
    // hadolint reads .hadolint.yaml only from its working directory, never in stdin mode.
    const quality = readFileSync(join(templateDir("code-quality"), "tools", "quality.sh"), "utf8");
    expect(quality).not.toMatch(/hadolint[^\n]*\s-\s*</);
    expect(quality).toContain('-v "$PWD:/workspace:ro" -w /workspace');
  });
});

// SAFETY: repo-owned pre-commit config; the fields read are checked by the assertions using them.
const preCommitHooks = (
  Bun.YAML.parse(
    readFileSync(join(templateDir("code-quality"), ".pre-commit-config.yaml"), "utf8"),
  ) as { repos: { hooks: { id: string; args?: string[]; files?: string; exclude?: string }[] }[] }
).repos.flatMap((repo) => repo.hooks);

/** The one hook configured under `id`. */
const preCommitHook = (id: string) => {
  const found = preCommitHooks.filter((hook) => hook.id === id);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("pre-commit accepts the app's own Compose files", () => {
  test("Compose merge tags (`!override`) are checked for syntax only", () => {
    const checkYaml = preCommitHooks.filter((hook) => hook.id === "check-yaml");
    const strict = checkYaml.filter((hook) => !(hook.args ?? []).includes("--unsafe"));
    const syntaxOnly = checkYaml.filter((hook) => (hook.args ?? []).includes("--unsafe"));
    expect(strict).toHaveLength(1);
    expect(syntaxOnly).toHaveLength(1);

    for (const path of ["deploy/compose/compose.ports.override.yaml", "compose.override.yaml"]) {
      expect(new RegExp(strict[0]!.exclude ?? "$^").test(path), `strict skips ${path}`).toBe(true);
      expect(new RegExp(syntaxOnly[0]!.files ?? "$^").test(path), `--unsafe covers ${path}`).toBe(
        true,
      );
    }
    expect(new RegExp(strict[0]!.exclude ?? "$^").test(".github/workflows/ci.yml")).toBe(false);
  });
});

describe("pre-commit accepts every file a capability vendors", () => {
  // An app commits the files the CLI vendors, so a template file its own hooks reject fails the
  // first commit and, on `mistral apps registry update`, rolls the whole update back. These stand in
  // for the two content hooks of code-quality's `.pre-commit-config.yaml` that registry files have
  // tripped, reading each hook's exclude and args from that config. The check-json stand-in does
  // not reject duplicate keys, and it covers only `*.json`, not every file identify tags JSON.
  const vendored = capabilityLocalIds.flatMap((id) =>
    contributedPaths(id).flatMap((appPath) => {
      const plain = join(templateDir(id), appPath);
      const source = existsSync(plain) ? plain : `${plain}.hbs`;
      const bytes = readFileSync(source);
      // identify treats a file containing a NUL byte as binary, and the text hooks skip it.
      if (bytes.includes(0)) return [];
      return [{ source: rel(source), appPath, text: bytes.toString("utf8") }];
    }),
  );

  test("check-json parses every JSON file it does not exclude", () => {
    const exclude = new RegExp(preCommitHook("check-json").exclude ?? "$^");
    const offenders = vendored
      .filter(({ appPath }) => appPath.endsWith(".json") && !exclude.test(appPath))
      .flatMap(({ source, text }) =>
        // A `.hbs` carrier is graded as rendered with every capability and with none.
        (source.endsWith(".hbs")
          ? [new Set(capabilityLocalIds), new Set<string>()].map((present) =>
              renderHbs(text, present).replaceAll("\\{{", "{{"),
            )
          : [text]
        ).flatMap((json) => {
          try {
            JSON.parse(json);
            return [];
          } catch (error) {
            return [`${source}: ${String(error)}`];
          }
        }),
      );
    expect(offenders).toEqual([]);
  });

  test("trailing-whitespace finds nothing to strip", () => {
    // A `.hbs` carrier is graded raw: unlike Handlebars, `renderHbs` keeps the indentation of a
    // standalone block tag, so its output would report whitespace the CLI never writes.
    const markdownExts = (preCommitHook("trailing-whitespace").args ?? [])
      .filter((arg) => arg.startsWith("--markdown-linebreak-ext="))
      .flatMap((arg) => arg.split("=")[1]!.split(","));
    const offenders = vendored.flatMap(({ source, appPath, text }) => {
      const markdown = markdownExts.some((ext) => appPath.toLowerCase().endsWith(`.${ext}`));
      return text.split("\n").flatMap((raw, index) => {
        const line = raw.replace(/\r$/, "");
        const stripped = line.replace(/[ \t\v\f\r]+$/, "");
        // A markdown hard line break (exactly two trailing spaces after content) is kept.
        const kept = markdown && stripped !== "" && line === `${stripped}  ` ? line : stripped;
        return kept === line ? [] : [`${source}:${index + 1}`];
      });
    });
    expect(offenders).toEqual([]);
  });
});

describe("the testing capability measures what the selection installed", () => {
  const testing = templateDir("testing");

  test("pytest collects by glob, never a capability's fixed path", () => {
    const ini = readFileSync(join(testing, "pytest.ini"), "utf8");
    const testpaths = ini
      .split("\n")
      .filter((line) => line.startsWith("    "))
      .map((line) => line.trim());
    expect(testpaths).toEqual(["tests", "packages/py/*/tests", "apps/*/tests"]);
  });

  test("coverage names no source list that a selection could leave dangling", () => {
    // tools/testing.sh discovers `--cov=<root>` from the layout; a fixed `source =` named packages
    // (evals) that most selections do not install.
    const rc = readFileSync(join(testing, ".coveragerc"), "utf8");
    expect(rc).not.toMatch(/^source\s*=/m);
    expect(readFileSync(join(testing, "tools", "testing.sh"), "utf8")).toContain("cov_sources");
  });

  test("the web gate counts only the web app's own files", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-gate-"));
    try {
      const lcov = join(dir, "lcov.info");
      writeFileSync(
        lcov,
        "SF:src/own.ts\nDA:1,1\nDA:2,0\nend_of_record\n" +
          "SF:../../packages/ts/markdown/src/parse.ts\nDA:1,0\nDA:2,0\nDA:3,0\nend_of_record\n",
      );
      const gate = spawnSync("bash", [join(testing, "tools", "coverage-gate.sh"), lcov, "50"], {
        encoding: "utf8",
      });
      expect(gate.status, gate.stderr).toBe(0);
      expect(gate.stdout).toContain("1/2 lines covered (50.00%)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app declares its own settings in a committed file", () => {
    // Capability envVars feed the generated, gitignored .env; the app's own settings need a
    // committed home, or the env contract fails the moment an app adds a setting.
    const example = readFileSync(join(templateDir("core"), ".env.example"), "utf8");
    const contract = readFileSync(join(testing, "tests", "test_composed_env_contract.py"), "utf8");
    expect(contract).toContain('_REPO_ROOT / ".env.example"');
    // Nothing loads .env.example, so it declares names only; a default lives on the settings field.
    const valued = example.split("\n").filter((line) => /^[A-Z][A-Z0-9_]*=\S/.test(line.trim()));
    expect(valued).toEqual([]);
  });

  test("the env contract reads capability envVars from the committed ledger, not only .env", () => {
    // `.env` is gitignored: a contract that needs it skips in every fresh clone, so CI never runs it.
    const contract = readFileSync(join(testing, "tests", "test_composed_env_contract.py"), "utf8");
    expect(contract).toContain('_REPO_ROOT / ".mistral"');
    expect(contract).toContain('"capabilities.json"');
    expect(contract).toContain('"registries.json"');
  });
});

describe("tools/uv.sh", () => {
  const uvSh = join(templateDir("core"), "tools", "uv.sh");

  /** Run the wrapper with a stub `uv` that prints the index environment it was handed. */
  const runWith = (args: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "uv-sh-"));
    try {
      mkdirSync(join(dir, "bin"));
      const stub = join(dir, "bin", "uv");
      writeFileSync(stub, '#!/bin/sh\necho "args=$* default=${UV_DEFAULT_INDEX-unset}"\n');
      chmodSync(stub, 0o755);
      const result = spawnSync("bash", [uvSh, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("pins the public default index for resolution", () => {
    expect(runWith(["lock"])).toBe("args=lock default=https://pypi.org/simple");
  }, 30_000);

  test("does not hand `uv add` an index to write into the member pyproject", () => {
    // With UV_DEFAULT_INDEX exported, `uv add` persisted a nameless `[[tool.uv.index]]
    // default = true` into the member it edited.
    expect(runWith(["add", "humanize"])).toBe("args=add humanize default=unset");
    expect(runWith(["remove", "humanize"])).toBe("args=remove humanize default=unset");
  }, 30_000);

  test.skipIf(Bun.which("zsh") === null)(
    "can be sourced from zsh without strict mode",
    () => {
      const result = spawnSync(
        "zsh",
        ["-c", `. '${uvSh}' && false; echo "alive default=$UV_DEFAULT_INDEX"`],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } },
      );
      expect(result.stderr).not.toContain("BASH_SOURCE");
      expect(result.stdout.trim()).toBe("alive default=https://pypi.org/simple");
    },
    30_000,
  );
});

const clientFile = (dir: string) =>
  join(dir, "apps", "web", "src", "api", "generated", "sdk.gen.ts");

/** A throwaway app with stub `tools/uv.sh` and `bunx`; see `checkIn`. */
const withApp = (body: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "gen-types-"));
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "apps", "api"), { recursive: true });
    mkdirSync(join(dir, "apps", "web", "src", "api", "generated"), { recursive: true });
    // `bash tools/uv.sh run --no-sync gen-openapi <path>`: the path is the fourth argument.
    writeFileSync(join(dir, "tools", "uv.sh"), 'printf "%s" "$GEN_SPEC" > "$4"\n');
    const bunx = join(dir, "bin", "bunx");
    writeFileSync(bunx, '#!/bin/sh\nprintf "%s" "$GEN_CLIENT" > src/api/generated/sdk.gen.ts\n');
    chmodSync(bunx, 0o755);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("the web API client matches the app's own composition", () => {
  const genTypes = join(templateDir("fastapi-tanstack-start"), "tools", "gen-types.sh");
  /**
   * Run `gen-types.sh --check` in a throwaway app whose stub `tools/uv.sh` (for `gen-openapi`) and
   * `bunx` (for hey-api) write `spec` and `client`: what a fresh generation yields. No git anywhere.
   */
  const checkIn = (dir: string, spec: string, client: string) =>
    spawnSync("bash", [genTypes, "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, GEN_SPEC: spec, GEN_CLIENT: client },
    });

  test("install-all regenerates the scaffold's full-composition client for this selection", () => {
    // The CLI only copies files, so the committed client is the one generated for every capability.
    // Without this step a pristine app of any smaller selection fails its own `fastapi-tanstack-start:gen-types-check`.
    const install = readFileSync(join(templateDir("core"), "tools", "install.sh"), "utf8");
    expect(install).toMatch(
      /if \[ -f tools\/gen-types\.sh \]; then\n\s+bash tools\/gen-types\.sh\n/,
    );
  });

  test("the nx targets drive the one script", () => {
    const project = readFileSync(
      join(
        templateDir("fastapi-tanstack-start"),
        "packages",
        "ts",
        "fastapi-tanstack-start",
        "project.json",
      ),
      "utf8",
    );
    expect(project).toContain('"command": "bash tools/gen-types.sh"');
    expect(project).toContain('"command": "bash tools/gen-types.sh --check"');
  });

  test("--check passes on a correct regeneration that is not staged", () => {
    // It used to diff against the git index: a correct but unstaged regeneration failed.
    withApp((dir) => {
      writeFileSync(clientFile(dir), "same");
      const result = checkIn(dir, "{}", "same");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("generated API client matches the API");
    });
  });

  test("--check fails on a stale client, regenerates it, and names what to commit", () => {
    withApp((dir) => {
      writeFileSync(clientFile(dir), "stale");
      const result = checkIn(dir, "{}", "fresh");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("add apps/api/openapi.json apps/web/src/api/generated");
      expect(readFileSync(clientFile(dir), "utf8")).toBe("fresh");
    });
  });

  test("--check compares the spec only once one has been written", () => {
    withApp((dir) => {
      writeFileSync(clientFile(dir), "same");
      expect(checkIn(dir, "{}", "same").status).toBe(0);
      // The spec now exists: a route change that moves the spec but not the client is drift too.
      expect(checkIn(dir, '{"paths":{}}', "same").status).toBe(1);
    });
  });
});

describe("web:gen-routes writes the route tree without a build", () => {
  test("the web project ships the target and the script it runs", () => {
    // `routeTree.gen.ts` is gitignored and only the Start Vite plugin writes it, so a fresh
    // checkout cannot type-check until something has run Vite.
    const web = join(templateDir("tanstack-start"), "apps", "web");
    expect(readFileSync(join(web, "project.json"), "utf8")).toContain(
      '"command": "bun scripts/gen-routes.ts"',
    );
    expect(readFileSync(join(web, "scripts", "gen-routes.ts"), "utf8")).toContain(
      'import { createServer } from "vite";',
    );
  });
});
