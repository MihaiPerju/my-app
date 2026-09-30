import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrap,
  deprecateCommand,
  loginCommand,
  publishCommand,
  targetFromEnvironment,
  trustCommand,
  writeSkeleton,
  type TrustTarget,
} from "../../../scripts/release/bootstrap-npm";

const TARGET: TrustTarget = {
  userconfig: "/tmp/npmrc-bootstrap",
  repository: "mistralai/mistralai-capabilities",
  workflow: "publish.yaml",
  environment: "publish",
};

/** Collects the commands `bootstrap` runs, failing the ones named in `fail`. */
function recorder(fail: Record<string, number> = {}) {
  const commands: string[][] = [];
  const runner = async (command: readonly string[]): Promise<number> => {
    commands.push([...command]);
    for (const [needle, code] of Object.entries(fail)) {
      if (command.join(" ").includes(needle)) return code;
    }
    return 0;
  };
  // `npm publish <dir>` carries a temporary path, so the shape is what can be asserted on.
  const verbs = (): string[] =>
    commands.map((command) => {
      const [, verb] = command;
      const subject =
        verb === "trust" || verb === "deprecate"
          ? command[verb === "trust" ? 3 : 2]
          : verb === "publish"
            ? "<skeleton>"
            : "";
      return `${verb}${subject === "" ? "" : ` ${subject}`}`;
    });
  return { commands, runner, verbs };
}

async function withTempRoot(body: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cap-bootstrap-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("npm bootstrap commands", () => {
  test("the skeleton is a bare name and version, with no licence and no other files", async () => {
    await withTempRoot((root) => {
      const dir = writeSkeleton("@mistralai-capabilities/chat", root);
      const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

      // The Apache-2.0 grant belongs to the release the staging job puts out, not to a placeholder
      // that exists only so npm has something to attach a trusted publisher to.
      expect(manifest).toEqual({ name: "@mistralai-capabilities/chat", version: "0.0.0" });
      expect(readdirSync(dir)).toEqual(["package.json"]);
    });
  });

  test("two skeletons in one run get their own directories", async () => {
    await withTempRoot((root) => {
      const first = writeSkeleton("@mistralai-capabilities/chat", root);
      const second = writeSkeleton("@mistralai-capabilities/search", root);

      expect(first).not.toBe(second);
      expect(JSON.parse(readFileSync(join(second, "package.json"), "utf8")).name).toBe(
        "@mistralai-capabilities/search",
      );
    });
  });

  test("login names the web flow so a runner config cannot leave it waiting on stdin", () => {
    const command = loginCommand(TARGET.userconfig);

    expect(command.slice(0, 2)).toEqual(["npm", "login"]);
    expect(command[command.indexOf("--auth-type") + 1]).toBe("web");
    expect(command[command.indexOf("--registry") + 1]).toBe("https://registry.npmjs.org/");
    expect(command[command.indexOf("--userconfig") + 1]).toBe(TARGET.userconfig);
  });

  test("the skeleton publishes public, under its own tag, through the throwaway config", () => {
    const command = publishCommand("/tmp/skeleton-abc", TARGET.userconfig);

    expect(command.slice(0, 3)).toEqual(["npm", "publish", "/tmp/skeleton-abc"]);
    expect(command[command.indexOf("--tag") + 1]).toBe("bootstrap");
    expect(command[command.indexOf("--access") + 1]).toBe("public");
    expect(command[command.indexOf("--registry") + 1]).toBe("https://registry.npmjs.org/");
    expect(command[command.indexOf("--userconfig") + 1]).toBe(TARGET.userconfig);
  });

  // npmjs.org points `latest` at a package's first version whatever `--tag` asks for, so an
  // untagged `bun add` reaches the empty skeleton until the real release is approved. The
  // deprecation is the only warning anyone installing in that window gets.
  test("the skeleton is deprecated at the version it was published under", () => {
    const command = deprecateCommand("@mistralai-capabilities/chat", TARGET.userconfig);

    expect(command.slice(0, 3)).toEqual(["npm", "deprecate", "@mistralai-capabilities/chat@0.0.0"]);
    expect(command[3]).toContain("Placeholder");
    expect(command[command.indexOf("--registry") + 1]).toBe("https://registry.npmjs.org/");
    expect(command[command.indexOf("--userconfig") + 1]).toBe(TARGET.userconfig);
  });

  test("the trusted publisher names one workflow and one environment, and may only stage", () => {
    const command = trustCommand("@mistralai-capabilities/chat", TARGET);

    expect(command.slice(0, 4)).toEqual(["npm", "trust", "github", "@mistralai-capabilities/chat"]);
    expect(command[command.indexOf("--repo") + 1]).toBe("mistralai/mistralai-capabilities");
    expect(command[command.indexOf("--file") + 1]).toBe("publish.yaml");
    expect(command[command.indexOf("--env") + 1]).toBe("publish");
    expect(command).toContain("-y");
    // Without this the staging job's OIDC token could make a version installable on its own,
    // skipping the `npm stage approve` the whole pipeline is built around.
    expect(command).toContain("--allow-stage-publish");
    expect(command).not.toContain("--allow-publish");
  });
});

describe("npm bootstrap target", () => {
  const complete = {
    NPM_USERCONFIG: "/run/npmrc",
    GITHUB_REPOSITORY: "mistralai/mistralai-capabilities",
  };

  test("the workflow and environment fall back to the ones the release actually uses", () => {
    expect(targetFromEnvironment(complete)).toEqual({
      userconfig: "/run/npmrc",
      repository: "mistralai/mistralai-capabilities",
      workflow: "publish.yaml",
      environment: "publish",
    });
  });

  test("an explicit workflow and environment win", () => {
    expect(
      targetFromEnvironment({
        ...complete,
        NPM_TRUST_WORKFLOW: "publish-rc.yaml",
        NPM_TRUST_ENVIRONMENT: "publish-rc",
      }),
    ).toMatchObject({ workflow: "publish-rc.yaml", environment: "publish-rc" });
  });

  // An unset `NPM_USERCONFIG` would send npm at `~/.npmrc`, where the logout step cannot reach the
  // session it leaves behind. An empty one resolves to the current directory.
  test.each([
    ["userconfig unset", { GITHUB_REPOSITORY: "o/r" }, "NPM_USERCONFIG"],
    ["userconfig empty", { ...complete, NPM_USERCONFIG: "" }, "NPM_USERCONFIG"],
    ["repository unset", { NPM_USERCONFIG: "/run/npmrc" }, "GITHUB_REPOSITORY"],
    ["repository empty", { ...complete, GITHUB_REPOSITORY: "" }, "GITHUB_REPOSITORY"],
  ] as const)("%s is refused", (_case, env, missing) => {
    expect(() => targetFromEnvironment(env)).toThrow(`${missing} is required`);
  });
});

describe("npm bootstrap sequence", () => {
  test("every package is created, deprecated and trusted, in the order given", async () => {
    await withTempRoot(async (root) => {
      const { runner, verbs } = recorder();

      await bootstrap(["@scope/a", "@scope/b"], TARGET, runner, root);

      // npm will not attach a trusted publisher to a name it does not hold, so publish precedes
      // trust for each package rather than all publishes preceding all trusts.
      expect(verbs()).toEqual([
        "login",
        "publish <skeleton>",
        "deprecate @scope/a@0.0.0",
        "trust @scope/a",
        "publish <skeleton>",
        "deprecate @scope/b@0.0.0",
        "trust @scope/b",
      ]);
    });
  });

  test("a failed login publishes nothing", async () => {
    await withTempRoot(async (root) => {
      const { runner, verbs } = recorder({ "npm login": 1 });

      await expect(bootstrap(["@scope/a"], TARGET, runner, root)).rejects.toThrow(
        "npm login failed",
      );
      expect(verbs()).toEqual(["login"]);
    });
  });

  test("a failed publish stops before the trust call and before the next package", async () => {
    await withTempRoot(async (root) => {
      const { runner, verbs } = recorder({ "npm publish": 1 });

      await expect(bootstrap(["@scope/a", "@scope/b"], TARGET, runner, root)).rejects.toThrow(
        "failed to publish the @scope/a skeleton",
      );
      expect(verbs()).toEqual(["login", "publish <skeleton>"]);
    });
  });

  // A created but untrusted package is the one state a person has to finish by hand: the name is
  // taken for good and the staging job has no way to reach it, so the error has to say so.
  test("a failed trust stops the run and says the package needs finishing by hand", async () => {
    await withTempRoot(async (root) => {
      const { runner, verbs } = recorder({ "npm trust": 1 });

      await expect(bootstrap(["@scope/a", "@scope/b"], TARGET, runner, root)).rejects.toThrow(
        "published the @scope/a skeleton but failed to attach its trusted publisher",
      );
      // The skeleton is deprecated by the time trust runs, so the one path that leaves a package
      // behind leaves it carrying its warning.
      expect(verbs()).toEqual([
        "login",
        "publish <skeleton>",
        "deprecate @scope/a@0.0.0",
        "trust @scope/a",
      ]);
    });
  });

  // The skeleton is installable as `latest` the moment it publishes, so a failed deprecation is the
  // one case where nobody gets a warning. The error names both halves a person has to finish.
  test("a failed deprecation stops before the trust call and names the installable version", async () => {
    await withTempRoot(async (root) => {
      const { runner, verbs } = recorder({ "npm deprecate": 1 });

      const failure = bootstrap(["@scope/a", "@scope/b"], TARGET, runner, root);

      await expect(failure).rejects.toThrow("@scope/a@0.0.0 is installable as `latest`");
      await expect(failure).rejects.toThrow("attach its trusted publisher");
      expect(verbs()).toEqual(["login", "publish <skeleton>", "deprecate @scope/a@0.0.0"]);
    });
  });

  test("an empty package list is refused before anything logs in", async () => {
    const { runner, commands } = recorder();

    await expect(bootstrap([], TARGET, runner)).rejects.toThrow("no packages to bootstrap");
    expect(commands).toEqual([]);
  });
});
