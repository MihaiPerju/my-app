import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { readTemplateJson } from "../support/registry-fixtures";
import { readJson, REGISTRY_ROOT, templateDir } from "../support/template-tree";

/**
 * One toolchain is declared in three file formats that cannot see each other: a Docker image tag,
 * a JSON field, and a workflow input. They can disagree silently: CI passes on the pinned version
 * while `docker build` uses whatever the tag resolved to. These tests catch the hand edit, the new
 * job, and the deleted pin that Renovate never sees.
 */
/** Every `label=version` a pattern finds, so a failure names the file that disagreed. */
const sightings = (label: string, source: string, pattern: RegExp) =>
  [...source.matchAll(pattern)].map(([, version]) => `${label}=${version}`);
const count = (source: string, pattern: RegExp) => (source.match(pattern) ?? []).length;
/** The distinct versions among some sightings. More than one is the drift. */
const agree = (found: string[]) => new Set(found.map((s) => s.split("=")[1]));

// Each backend and deployment capability owns its Python image; web and gateway keep their own stacks.
const readDockerfile = (cap: string, name: string) =>
  readFileSync(join(templateDir(cap), "deploy", "docker", name), "utf8");

/** Body of the `FROM ... AS <stage>` block, up to the next `FROM ` or EOF (trailing blanks trimmed). */
const dockerStageBody = (df: string, stage: string): string => {
  const lines = df.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^FROM .* AS ${stage}$`).test(l));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("FROM ")) end += 1;
  return lines.slice(start, end).join("\n").trimEnd();
};

describe("toolchain pins", () => {
  const CORE = templateDir("core");
  // CI and Renovate now belong to the `github-automation` capability, not core. The workflow is a
  // Handlebars carrier (`ci.yml.hbs`); its toolchain pins live in the raw text unconditionally
  // (gated jobs still contain their `setup-uv`/`setup-bun` steps), so pin counting reads it raw.
  const AUTOMATION = templateDir("github-automation");
  const templateCi = readFileSync(join(AUTOMATION, ".github", "workflows", "ci.yml.hbs"), "utf8");
  // setup-uv and its uv-version pin/Renovate annotation moved out of the workflow into the
  // composite action every uv job invokes (`.github/actions/uv-workspace/action.yml`). Renovate's
  // custom manager scans workflows AND `.github/actions/*/action.yml`, so pin-counting and the
  // Renovate-visibility check must read both; `templatePins` is the workflow + action seen as one.
  const uvAction = readFileSync(
    join(AUTOMATION, ".github", "actions", "uv-workspace", "action.yml"),
    "utf8",
  );
  const templatePins = `${templateCi}\n${uvAction}`;

  const TEMPLATE_BUN = [
    `package.json=${readTemplateJson<{ packageManager: string }>(join(CORE, "package.json")).packageManager.replace("bun@", "")}`,
    ...sightings("ci.yml.hbs", templateCi, /bun-version:\s*"?([\d.]+)"?/g),
    ...sightings(
      "Dockerfile.web",
      readDockerfile("tanstack-start", "Dockerfile.web"),
      /oven\/bun:(\S+)/g,
    ),
  ];

  // Anchored on the Renovate annotation, not on the bare `version:` input: that key is generic
  // enough that the next action wired in with a `version:` of its own would be read as a uv
  // sighting and fail this on a version that has nothing to do with uv. setup-uv lives in the
  // composite action now, so scan the workflow + action pair.
  const TEMPLATE_UV_CI = sightings(
    "uv-workspace/action.yml",
    templatePins,
    /depName=astral-sh\/uv\s*\n\s*version: "([\d.]+)"/g,
  );
  // Each Python service image is self-contained: the same build+runtime base copies uv into both
  // stages once. `cap`/`name` locate it, `targets` are the stages it must define, and `dev` says
  // whether it carries the shared development stage.
  const PYTHON_IMAGES = [
    {
      cap: "fastapi",
      name: "Dockerfile.api",
      targets: ["api", "development", "api-dev"],
      dev: true,
    },
    {
      cap: "workflows",
      name: "Dockerfile.worker",
      targets: ["workflows", "development", "workflows-dev", "default"],
      dev: true,
    },
    { cap: "docker-compose", name: "Dockerfile.init", targets: ["init"], dev: false },
  ] as const;
  const TEMPLATE_UV_DOCKER = PYTHON_IMAGES.flatMap(({ cap, name }) =>
    sightings(name, readDockerfile(cap, name), /astral-sh\/uv:(\S+)/g),
  );
  const TEMPLATE_UV = [...TEMPLATE_UV_CI, ...TEMPLATE_UV_DOCKER];

  test("a generated app installs one bun, everywhere it names one", () => {
    // Counted against the setup-bun steps rather than hardcoded, so a NEW job with an unpinned bun
    // fails here instead of passing because the pins it does have happen to match. The Docker
    // sighting is asserted separately: `oven/bun:1` matches the pattern too, so the pin only
    // counts if it agrees on the exact version below.
    // Guard against a vacuous 0 == 0: a CI that names no setup-bun step at all would otherwise pass.
    expect(count(templateCi, /uses: oven-sh\/setup-bun@/g)).toBeGreaterThan(0);
    expect(count(templateCi, /uses: oven-sh\/setup-bun@/g)).toBe(
      count(templateCi, /bun-version:/g),
    );
    expect(TEMPLATE_BUN.filter((s) => s.startsWith("Dockerfile.web="))).toHaveLength(1);
    expect(agree(TEMPLATE_BUN), TEMPLATE_BUN.join(" ")).toHaveLength(1);
  });

  test("the web image invokes the NX target without forwarding workspace flags to Vite", () => {
    const dockerfile = readDockerfile("tanstack-start", "Dockerfile.web");
    expect(dockerfile).toContain("RUN bun x nx run web:build");
    expect(dockerfile).not.toContain("bun run build -F web");
  });

  test("a generated app installs one uv, everywhere it names one", () => {
    // Guard against a vacuous 0 == 0: a workflow+action pair that names no setup-uv step at all
    // would otherwise pass. setup-uv lives in the composite action now, so scan the pair.
    expect(count(templatePins, /uses: astral-sh\/setup-uv@/g)).toBeGreaterThan(0);
    expect(TEMPLATE_UV_CI).toHaveLength(count(templatePins, /uses: astral-sh\/setup-uv@/g));
    expect(TEMPLATE_UV_DOCKER).toHaveLength(PYTHON_IMAGES.length * 2);
    expect(agree(TEMPLATE_UV), TEMPLATE_UV.join(" ")).toHaveLength(1);
  });

  test("every Python image shares one workspace build pipeline", () => {
    const helper = readFileSync(join(CORE, "tools", "docker", "sync-python-workspace.sh"), "utf8");
    expect(helper.match(/^\s*exec uv sync /gm)).toHaveLength(3);
    for (const { cap, name, targets, dev } of PYTHON_IMAGES) {
      const df = readDockerfile(cap, name);
      expect(df.match(/^FROM .* AS (?:build|runtime)$/gm), `${name} build+runtime`).toHaveLength(2);
      for (const target of targets) {
        expect(df, `${name} defines ${target}`).toContain(` AS ${target}`);
      }
      expect(df.match(/COPY --parents /g), `${name} copies the workspace once`).toHaveLength(1);
      expect(df.match(/sync-python-workspace dependencies/g), `${name} deps`).toHaveLength(1);
      expect(df.match(/sync-python-workspace runtime/g), `${name} runtime`).toHaveLength(1);
      expect(df.match(/sync-python-workspace dev/g) ?? [], `${name} dev`).toHaveLength(dev ? 1 : 0);
    }
  });

  test("Python images derive the registry username from core's projected wrapper", () => {
    for (const { cap, name } of PYTHON_IMAGES) {
      const df = readDockerfile(cap, name);
      expect(df).toContain("COPY tools/uv.sh /tmp/registry-uv.sh");
      expect(df).not.toContain("ARG REGISTRY_PY_USER=mistralai");
      expect(df).toContain(
        `registry_user="\${REGISTRY_PY_USER:-$(sed -n 's/^export MISTRAL_REGISTRY_USER=//p' /tmp/registry-uv.sh)}"`,
      );
    }
  });

  test("the build and runtime stages are byte-identical across the Python images", () => {
    // The three images intentionally duplicate the shared workspace build. That is only safe if a
    // security, credential, or base-image fix to one is a fix to all, so the `build` and `runtime`
    // stage bodies must match exactly; a drift in any one fails here.
    for (const stage of ["build", "runtime"] as const) {
      const bodies = PYTHON_IMAGES.map(({ cap, name }) => ({
        name,
        body: dockerStageBody(readDockerfile(cap, name), stage),
      }));
      expect(bodies[0]!.body, `${stage} stage present`).not.toHaveLength(0);
      for (const { name, body } of bodies.slice(1)) {
        expect(body, `${name} ${stage} stage matches ${bodies[0]!.name}`).toBe(bodies[0]!.body);
      }
    }
  });

  // Renovate grouping only fires on deps it can see, and a `with:` input is invisible to every
  // native manager. The custom manager closes that gap via `# renovate:` annotations, so an
  // annotation its own regex does not match is worse than none: it reads as covered but is not.
  // This is compiled from the config, not restated, so it cannot drift from what Renovate runs.
  test("every pinned toolchain input in a generated app's CI is one Renovate can see", () => {
    const config = readJson<{ customManagers: { matchStrings: string[] }[] }>(
      join(AUTOMATION, "renovate.json"),
    );
    const matchStrings = config.customManagers.flatMap((m) => m.matchStrings);
    expect(matchStrings).toHaveLength(1);

    const annotated = count(templatePins, new RegExp(matchStrings[0]!, "g"));
    const pinned =
      count(templatePins, /uses: oven-sh\/setup-bun@/g) +
      count(templatePins, /uses: astral-sh\/setup-uv@/g);
    expect(annotated, `${annotated} of ${pinned} pinned inputs are Renovate-visible`).toBe(pinned);
  });

  // The registry is the only thing that ever proves a generated app builds: `bun run e2e` generates
  // one and checks it, framework-check lints the vendored sources, publish cuts the dists. All three
  // run on the RUNNER's toolchain, not the app's -- so if these drift from what the template pins,
  // the e2e proves a build that no user will ever perform. Same class as the bug above, one level up.
  test("the registry builds generated apps with the toolchain it pins into them", () => {
    const workflows = join(REGISTRY_ROOT, ".github", "workflows");
    const sources = readdirSync(workflows).map(
      (f) => [f, readFileSync(join(workflows, f), "utf8")] as const,
    );
    const registryBun = sources.flatMap(([f, src]) =>
      sightings(f, src, /bun-version:\s*"?([\d.]+)"?/g),
    );
    // The version input sits a few lines under the `uses:`, past `with:` and any sibling input.
    // Bounded to the step rather than the file so it cannot reach into the next one.
    const registryUv = sources.flatMap(([f, src]) =>
      sightings(f, src, /setup-uv@[^\n]*\n(?:[^\n]*\n){0,4}?\s*version: "([\d.]+)"/g),
    );

    // Every setup step must have produced a sighting. Three setup-uv steps here carried no
    // `version:` at all and silently tracked latest; this is what keeps them pinned.
    const steps = (pattern: RegExp) =>
      sources.reduce((total, [, src]) => total + count(src, pattern), 0);
    expect(registryBun).toHaveLength(steps(/uses: oven-sh\/setup-bun@/g));
    expect(registryUv).toHaveLength(steps(/uses: astral-sh\/setup-uv@/g));
    expect(registryBun.length).toBeGreaterThan(0);
    expect(registryUv.length).toBeGreaterThan(0);
    expect(
      agree([...registryBun, ...TEMPLATE_BUN]),
      [...registryBun, ...TEMPLATE_BUN].join(" "),
    ).toHaveLength(1);
    expect(
      agree([...registryUv, ...TEMPLATE_UV]),
      [...registryUv, ...TEMPLATE_UV].join(" "),
    ).toHaveLength(1);
  });
});
