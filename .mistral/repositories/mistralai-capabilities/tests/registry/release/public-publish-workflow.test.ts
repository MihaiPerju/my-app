import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { REGISTRY_ROOT } from "../support/template-tree";

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: { name?: string };
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
  with?: {
    publish_internal?: string;
    publish_public?: string;
    publisher_ref?: string;
    ref?: string;
  };
}

interface Workflow {
  on?: {
    workflow_call?: {
      inputs?: Record<string, { default?: unknown; required?: boolean }>;
    };
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          default?: unknown;
          description?: string;
          options?: string[];
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
}

async function readWorkflow(name: string): Promise<Workflow> {
  const source = await Bun.file(join(REGISTRY_ROOT, ".github", "workflows", name)).text();
  // SAFETY: these are repository-owned YAML workflows. Missing or differently shaped fields remain
  // undefined and fail the assertions below rather than being trusted by production code.
  return Bun.YAML.parse(source) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const value = workflow.jobs?.[name];
  expect(value, `workflow is missing the ${name} job`).toBeDefined();
  return value!;
}

function runStep(workflowJob: WorkflowJob, name: string): string {
  const run = workflowJob.steps?.find((step) => step.name === name)?.run;
  expect(run, `job is missing the ${name} run step`).toBeDefined();
  return run!;
}

function checkoutRef(workflowJob: WorkflowJob): string | undefined {
  return workflowJob.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref;
}

describe("public publish workflow policy", () => {
  test("public publishing defaults off and only the exact manual confirmation enables it", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const release = await readWorkflow("publish.yaml");
    const rc = await readWorkflow("publish-rc.yaml");

    expect(core.on?.workflow_call?.inputs?.publish_internal?.default).toBe(true);
    expect(core.on?.workflow_call?.inputs?.publish_public?.default).toBe(false);
    expect(core.on?.workflow_call?.inputs?.publisher_ref?.required).toBe(true);
    expect(release.on?.workflow_dispatch?.inputs?.target).toEqual({
      description:
        "Upload destination. Internal retries Gemfury + Cloudsmith; public promotes to PyPI + npmjs only.",
      required: true,
      default: "internal",
      type: "choice",
      options: ["internal", "public"],
    });
    expect(release.on?.workflow_dispatch?.inputs?.public_publish_confirmation?.default).toBe("");
    const releaseJob = job(release, "publish");
    expect(releaseJob.with?.publish_internal).toContain("github.event_name == 'push'");
    expect(releaseJob.with?.publish_internal).toContain("inputs.target == 'internal'");
    expect(releaseJob.with?.publish_public).toContain("github.event_name == 'workflow_dispatch'");
    expect(releaseJob.with?.publish_public).toContain("inputs.target == 'public'");
    expect(releaseJob.with?.publish_public).toContain(
      "inputs.public_publish_confirmation == 'STAGE_NPM_AND_PUBLISH_PYPI'",
    );
    expect(releaseJob.with?.ref).toBe("${{ needs.version.outputs.ref }}");
    expect(releaseJob.with?.publisher_ref).toBe("${{ needs.version.outputs.ref }}");
    expect(runStep(job(release, "version"), "Resolve version")).toContain(
      'git rev-parse --verify "refs/tags/${TAG}^{commit}"',
    );
    const rcJob = job(rc, "publish");
    expect(rcJob.with?.ref).toBe("${{ needs.gate.outputs.sha }}");
    expect(rcJob.with?.publisher_ref).toBe("${{ github.sha }}");
    expect(rcJob.with).not.toHaveProperty("publish_internal");
    expect(rcJob.with).not.toHaveProperty("publish_public");
  });

  test("the public target skips both internal registries without weakening public gates", async () => {
    const core = await readWorkflow("publish-core.yaml");

    expect(job(core, "publish-gemfury").if).toBe("${{ inputs.publish_internal }}");
    expect(job(core, "publish-cloudsmith").if).toBe("${{ inputs.publish_internal }}");

    const pypi = job(core, "publish-pypi");
    expect(pypi.needs).toContain("publish-gemfury");
    expect(pypi.needs).toContain("publish-cloudsmith");
    expect(pypi.if).toContain("!cancelled()");
    expect(pypi.if).toContain("!inputs.publish_internal");
    expect(pypi.if).toContain("needs.publish-gemfury.result == 'success'");
    expect(pypi.if).toContain("needs.publish-cloudsmith.result == 'success'");
  });

  test("every release run serialises against every other one", async () => {
    const release = await readWorkflow("publish.yaml");

    // A group keyed on the tag would let two releases run at once, and the newest-tag check in
    // the `version` job only holds against a single publisher.
    expect(release.concurrency?.group).toBe("publish");
    expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("a dispatched release names the version it publishes", async () => {
    const release = await readWorkflow("publish.yaml");

    // A dispatch runs from `main`, so an omitted version could only be inferred from whichever tag
    // was newest at the time.
    expect(release.on?.workflow_dispatch?.inputs?.version?.required).toBe(true);

    const resolve = runStep(job(release, "version"), "Resolve version");
    expect(resolve).toContain(
      "public target requires public_publish_confirmation=STAGE_NPM_AND_PUBLISH_PYPI",
    );
    expect(resolve).toContain("NEWEST=\"$(git tag --list 'v*' | highest)\"");
    expect(resolve).toContain(
      `if [ "$(printf '%s\\n%s\\n' "$VERSION" "$NEWEST" | sort -V | tail -1)" != "$VERSION" ]; then`,
    );
  });

  test("credential-bearing checkouts use the trusted publisher ref", async () => {
    const core = await readWorkflow("publish-core.yaml");

    expect(checkoutRef(job(core, "build"))).toBe("${{ inputs.ref }}");
    for (const jobName of [
      "publish-gemfury",
      "publish-cloudsmith",
      "publish-npmjs",
      "npmjs-bootstrap",
      "release",
    ]) {
      expect(checkoutRef(job(core, jobName)), jobName).toBe("${{ inputs.publisher_ref }}");
    }
  });

  test("the compliance scan gates the first public upload and reads the published artifact", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const scan = job(core, "public-artifacts");

    // The scan follows `inputs.ref` rather than the trusted publisher ref, because the manifests
    // that decide which artifacts are public must be the ones the artifact was built from. It holds
    // no credential and no environment, which is what makes that safe.
    expect(checkoutRef(scan)).toBe("${{ inputs.ref }}");
    expect(scan.permissions).toEqual({ contents: "read" });
    expect(scan.environment).toBeUndefined();
    expect(JSON.stringify(scan)).not.toContain("secrets.");
    expect(scan.if).toBe("${{ inputs.publish_public }}");

    // It must scan the same `dist` upload the publish jobs consume. A rebuild here would pass on a
    // second set of bytes while the first set is what reaches npmjs and PyPI.
    expect(
      scan.steps?.find((step) => step.uses?.startsWith("actions/download-artifact@"))?.with?.name,
    ).toBe("dist");
    expect(runStep(scan, "Inspect the artifacts that will be published")).toBe(
      "bun run public-artifacts:check --prebuilt",
    );

    // An artifact is a zip built from a file list, so the empty `dist/py-public` the build states
    // when no capability is public does not survive the download. Without this the scan reads a
    // stated empty set as a missing one and fails every release that publishes only the descriptor.
    expect(runStep(scan, "Restore the empty public Python set the artifact upload dropped")).toBe(
      "mkdir -p dist/py-public",
    );
  });

  test("both public jobs are OIDC-only protected-environment deployments", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const npmjs = job(core, "publish-npmjs");
    const pypi = job(core, "publish-pypi");

    for (const publicJob of [npmjs, pypi]) {
      expect(publicJob.permissions).toEqual({ contents: "read", "id-token": "write" });
      expect(publicJob.environment?.name).toBe("publish");
      expect(JSON.stringify(publicJob)).not.toContain("secrets.");
    }

    expect(npmjs.needs).toEqual(["build", "publish-pypi", "npmjs-preflight", "npmjs-bootstrap"]);
    expect(npmjs.if).toContain("inputs.publish_public");
    expect(npmjs.if).toContain("needs.publish-pypi.result == 'success'");
    expect(pypi.needs).toEqual([
      "build",
      "public-artifacts",
      "publish-gemfury",
      "publish-cloudsmith",
      "pypi-preflight",
      "npmjs-preflight",
    ]);
    expect(pypi.if).toContain("!cancelled()");
    expect(pypi.if).toContain("inputs.publish_public");
    expect(pypi.if).toContain("needs.public-artifacts.result == 'success'");
    expect(pypi.if).toContain("!inputs.publish_internal");
    expect(pypi.if).toContain("needs.publish-gemfury.result == 'success'");
    expect(pypi.if).toContain("needs.publish-cloudsmith.result == 'success'");
    expect(pypi.if).toContain("needs.pypi-preflight.result == 'success'");
    const pypiPublish = runStep(pypi, "Publish public Python dists through OIDC");
    expect(pypiPublish).toContain("--check-url https://pypi.org/simple/");
    expect(pypiPublish).toContain("--trusted-publishing always");
    expect(pypiPublish).toContain("shopt -s nullglob");
    expect(pypiPublish).toContain("public_dists=(dist/py-public/*.whl dist/py-public/*.tar.gz)");
    expect(pypiPublish).toContain("if (( ${#public_dists[@]} == 0 )); then");
    expect(pypiPublish).toContain('"${public_dists[@]}"');
    expect(pypiPublish).not.toMatch(/(^|[^-])dist\/py\/\*/);

    const releaseJob = job(core, "release");
    expect(releaseJob.if).toContain("!cancelled()");
    expect(releaseJob.if).toContain("inputs.github_release");
    expect(releaseJob.if).toContain("!inputs.publish_internal");
    expect(releaseJob.if).toContain("needs.publish-gemfury.result == 'success'");
    expect(releaseJob.if).toContain("needs.publish-cloudsmith.result == 'success'");
    // npm is last, so it is the one that says the whole public leg finished. Its own gate already
    // requires PyPI, so naming it here covers both.
    expect(releaseJob.if).toContain("needs.publish-npmjs.result == 'success'");
    expect(releaseJob.if).not.toContain("needs.publish-pypi.result");
    expect(releaseJob.if).not.toContain("always()");
  });

  // The npm jobs check `publish-pypi` and nothing further back, so that one job carries every
  // selected upstream destination for them. Drop a check here and both npm jobs lose it as well.
  test("the PyPI upload gates the selected internal leg before npm", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const pypi = job(core, "publish-pypi");

    expect(pypi.needs).toContain("public-artifacts");
    expect(pypi.if).toContain("needs.public-artifacts.result == 'success'");
    for (const gate of ["publish-gemfury", "publish-cloudsmith"]) {
      expect(pypi.needs, gate).toContain(gate);
      expect(pypi.if, gate).toContain(`needs.${gate}.result == 'success'`);
    }
    // Public-only promotion deliberately skips both internal jobs. The status-check function lets
    // the explicit `publish_internal` branch decide whether that skipped state is acceptable.
    expect(pypi.if).toContain("!cancelled()");
    expect(pypi.if).toContain("!inputs.publish_internal");
    for (const check of ["always()", "failure()"]) {
      expect(pypi.if, check).not.toContain(check);
    }
    for (const npmJob of ["npmjs-bootstrap", "publish-npmjs"]) {
      const value = job(core, npmJob);
      for (const gate of ["public-artifacts", "publish-gemfury", "publish-cloudsmith"]) {
        expect(value.if, `${npmJob} repeats ${gate}`).not.toContain(`needs.${gate}.`);
      }
    }
  });

  // A PyPI project name belongs to whoever uploads to it first, and a capability's name is not
  // public until `npmjs-bootstrap` publishes the skeleton under it. If npm went first, that publish
  // would announce a name nobody has claimed on PyPI yet, and the PyPI upload is hours behind it on
  // a second approval.
  test("PyPI uploads before anything makes a new capability's name public on npm", async () => {
    const core = await readWorkflow("publish-core.yaml");

    for (const jobName of ["npmjs-bootstrap", "publish-npmjs"]) {
      const value = job(core, jobName);
      expect(value.needs, jobName).toContain("publish-pypi");
      expect(value.if, jobName).toContain("needs.publish-pypi.result == 'success'");
    }
    expect(job(core, "publish-pypi").needs).not.toContain("publish-npmjs");
  });

  test("the PyPI report reaches the log before the approval gate and holds no credential", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const preflight = job(core, "pypi-preflight");

    expect(preflight.permissions).toEqual({ contents: "read" });
    expect(preflight.environment).toBeUndefined();
    expect(JSON.stringify(preflight)).not.toContain("secrets.");
    expect(runStep(preflight, "Ask pypi.org which public projects it already holds")).toBe(
      "bun scripts/release/pypi-package-existence.ts",
    );
    // The report is only worth anything to the person deciding whether to approve the upload, so
    // the upload has to wait on it.
    expect(job(core, "publish-pypi").needs).toContain("pypi-preflight");
  });

  // Nothing in the PyPI job touches npm, but `npmjs-preflight` fails when npmjs.org cannot say
  // whether a package exists, and that leaves the npm leg unable to finish. Approving the upload
  // anyway spends the one step of the release nobody can take back.
  test("the PyPI upload waits on the npm preflight it cannot recover from", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const pypi = job(core, "publish-pypi");

    expect(pypi.needs).toContain("npmjs-preflight");
    expect(pypi.if).toContain("needs.npmjs-preflight.result == 'success'");
    // Waiting on the preflight must not become waiting on an approval gate.
    expect(job(core, "npmjs-preflight").environment).toBeUndefined();
  });

  test.each([
    ["absent", false],
    ["empty", true],
  ] as const)(
    "an %s public Python directory succeeds without uv, a literal glob, or internal fallback",
    async (_state, materializePublicDirectory) => {
      const core = await readWorkflow("publish-core.yaml");
      const publish = runStep(
        job(core, "publish-pypi"),
        "Publish public Python dists through OIDC",
      );
      const root = mkdtempSync(join(tmpdir(), "cap-empty-public-py-"));
      const bin = join(root, "bin");
      const marker = join(root, "uv-called");

      try {
        const internal = join(root, "dist", "py");
        mkdirSync(internal, { recursive: true });
        writeFileSync(join(internal, "private-1.0.0-py3-none-any.whl"), "private");
        if (materializePublicDirectory) {
          mkdirSync(join(root, "dist", "py-public"), { recursive: true });
        }
        mkdirSync(bin);
        const uv = join(bin, "uv");
        writeFileSync(uv, `#!/usr/bin/env bash\nprintf called > "$UV_CALLED"\n`);
        chmodSync(uv, 0o755);

        const result = Bun.spawnSync(["bash", "-c", publish], {
          cwd: root,
          env: { PATH: `${bin}:${process.env.PATH ?? ""}`, UV_CALLED: marker },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("No public Python distributions to publish.");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("the npm preflight asks the public registry before any credential is in play", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const preflight = job(core, "npmjs-preflight");

    expect(preflight.permissions).toEqual({ contents: "read" });
    expect(preflight.environment).toBeUndefined();
    expect(JSON.stringify(preflight)).not.toContain("secrets.");
    expect(preflight.outputs?.missing).toBe("${{ steps.probe.outputs.missing }}");
    expect(runStep(preflight, "Ask npmjs.org which public packages exist")).toBe(
      "bun scripts/release/npm-package-existence.ts",
    );
  });

  test("the bootstrap job holds the only non-OIDC credential and contains it", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const bootstrap = job(core, "npmjs-bootstrap");

    expect(bootstrap.environment?.name).toBe("publish");
    // No `id-token: write`. Nothing here goes through OIDC, and a token the job cannot request is
    // one the trusted publisher cannot be talked into accepting from the wrong job.
    expect(bootstrap.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(bootstrap)).not.toContain("secrets.");

    // The session npm writes has publish rights over the whole scope. It goes to a file under the
    // runner temp that the job reserves, exports for the publish and logout steps, and deletes -
    // never `~/.npmrc`, and nothing built from a PR shares the runner with it. The path is derived
    // from `$RUNNER_TEMP` inside the step, not a job-level `env`, because `runner.temp` is not a
    // valid context there.
    const reserve = runStep(bootstrap, "Reserve the throwaway npm config");
    expect(reserve).toContain('NPM_USERCONFIG="$RUNNER_TEMP/npmrc-bootstrap"');
    expect(reserve).toContain('install -m 600 /dev/null "$NPM_USERCONFIG"');
    expect(reserve).toContain('echo "NPM_USERCONFIG=$NPM_USERCONFIG" >> "$GITHUB_ENV"');
    expect(
      bootstrap.steps?.some((step) => step.uses?.startsWith("actions/download-artifact@")),
    ).toBe(false);

    const logout = bootstrap.steps?.find(
      (step) => step.name === "Log out and discard the npm config",
    );
    expect(logout?.if).toBe("always()");
    expect(logout?.run).toContain("npm logout");
    expect(logout?.run).toContain('rm -f "$NPM_USERCONFIG"');

    // The job waits on a person opening npm's login URL, so an unattended run has to end by itself.
    expect(bootstrap["timeout-minutes"]).toBeGreaterThan(0);

    // npm's two-factor skip lasts five minutes, so every publish and trust call is one process.
    const publish = bootstrap.steps?.find(
      (step) => step.name === "Create, deprecate and trust the skeletons",
    );
    expect(publish?.run).toContain("bun scripts/release/bootstrap-npm.ts");
    expect(publish?.env?.NPM_TRUST_ENVIRONMENT).toBe("publish");
    expect(publish?.env?.MISSING).toBe("${{ needs.npmjs-preflight.outputs.missing }}");

    // A release that creates no package skips the bootstrap, which must not read as a failure. A
    // bootstrap that ran and failed must, or the staging job would publish against a missing name.
    const npmjs = job(core, "publish-npmjs");
    expect(npmjs.if).toContain("needs.npmjs-preflight.result == 'success'");
    expect(npmjs.if).toContain("needs.npmjs-bootstrap.result == 'success'");
    expect(npmjs.if).toContain("needs.npmjs-bootstrap.result == 'skipped'");
  });

  // GitHub wraps a job's `if` in `success()` unless it already names a status-check function, and
  // `success()` is false the moment any dependency is skipped. A job written to accept a skipped
  // dependency therefore never runs unless it opts out, which is invisible until a release does
  // the skip for real -- here, every release that creates no npm package.
  test("a job that accepts a skipped dependency opts out of the implicit success()", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const statusChecks = ["success()", "failure()", "cancelled()", "always()"];
    const accepting = Object.entries(core.jobs ?? {}).filter(([, value]) =>
      value.if?.includes("== 'skipped'"),
    );

    expect(accepting.map(([name]) => name)).toContain("publish-npmjs");
    for (const [name, value] of accepting) {
      expect(
        statusChecks.some((check) => value.if?.includes(check)),
        name,
      ).toBe(true);
    }
  });

  test("the bootstrap step passes the preflight's package list through as separate arguments", async () => {
    // `read -a` on an unquoted expansion is the whole of the list handling, and a release that
    // creates two packages is the first time anyone would find out it collapsed them into one.
    const core = await readWorkflow("publish-core.yaml");
    const script = runStep(
      job(core, "npmjs-bootstrap"),
      "Create, deprecate and trust the skeletons",
    );

    for (const [missing, expected] of [
      ["@scope/a", ["@scope/a"]],
      ["@scope/a @scope/b", ["@scope/a", "@scope/b"]],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "cap-bootstrap-args-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "bun"),
          `#!/usr/bin/env bash\nfor arg in "\${@:2}"; do printf '%s\\n' "$arg"; done\n`,
        );
        chmodSync(join(bin, "bun"), 0o755);

        const result = Bun.spawnSync(["bash", "-c", script], {
          cwd: root,
          env: { PATH: `${bin}:${process.env.PATH ?? ""}`, MISSING: missing },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim().split("\n")).toEqual([...expected]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("the cleanup step removes the npm config even when the logout itself fails", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const cleanup = runStep(job(core, "npmjs-bootstrap"), "Log out and discard the npm config");
    const root = mkdtempSync(join(tmpdir(), "cap-bootstrap-cleanup-"));

    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      // The realistic failure: the job timed out before anyone logged in, so there is no session
      // to revoke. The config still has to go, and the step still has to pass.
      writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\nexit 1\n");
      chmodSync(join(bin, "npm"), 0o755);
      const userconfig = join(root, "npmrc-bootstrap");
      writeFileSync(userconfig, "//registry.npmjs.org/:_authToken=session\n");

      const result = Bun.spawnSync(["bash", "-c", cleanup], {
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, NPM_USERCONFIG: userconfig },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(userconfig)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("npm uses the pinned staged-publish command and focused staging script", async () => {
    const core = await readWorkflow("publish-core.yaml");
    const npmjs = job(core, "publish-npmjs");
    const install = runStep(npmjs, "Install npm with staged publishing");
    const stage = runStep(npmjs, "Stage npm packages");

    expect(install).toContain("npm install --global npm@11.16.0");
    expect(install).toContain('test "$(npm --version)" = "11.16.0"');
    expect(stage).toBe("bun scripts/release/stage-npm.ts");
    expect(JSON.stringify(npmjs)).not.toContain("--provenance");

    const workflowSource = await Bun.file(
      join(REGISTRY_ROOT, ".github", "workflows", "publish-core.yaml"),
    ).text();
    expect(workflowSource).toContain(
      "workflow_ref` identifies the caller,\n      # not this reusable workflow",
    );

    const stageScript = await Bun.file(
      join(REGISTRY_ROOT, "scripts", "release", "stage-npm.ts"),
    ).text();
    expect(stageScript).toContain("npm provenance would expose the");
    expect(stageScript).toContain("source repository, which is private");
  });
});
