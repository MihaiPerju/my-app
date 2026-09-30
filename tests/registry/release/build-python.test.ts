import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  buildPythonDistributions,
  pythonBuildEnvironment,
  type PythonBuildRunner,
} from "../../../scripts/release/build-python";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cap-build-py-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function capability(
  kind: string,
  id: string,
  isPublic: boolean,
  dependencies?: string[],
  packages: string[] = ["py"],
): void {
  const capabilityRoot = join(root, "capabilities", kind, id);
  const pyDir = join(capabilityRoot, "package", "py");
  mkdirSync(pyDir, { recursive: true });
  writeFileSync(
    join(capabilityRoot, "capability.json"),
    JSON.stringify({
      id,
      kind,
      version: "0.0.0",
      packages,
      dependencies,
      metadata: { public: isPublic },
    }),
  );
  writeFileSync(
    join(pyDir, "pyproject.toml"),
    `[project]\nname = "mistralai-capabilities-${kind}-${id}"\n`,
  );
}

const quietLogger = { log: (_message: string) => {}, error: (_message: string) => {} };

describe("Python distribution build", () => {
  test("builds mixed public/private capabilities and preserves the complete internal set", async () => {
    capability("base", "core", true);
    capability("feature", "chat", false);
    const built: string[] = [];
    const runner: PythonBuildRunner = async (pyDir) => {
      const id = basename(dirname(dirname(pyDir)));
      const kind = basename(dirname(dirname(dirname(pyDir))));
      built.push(`${kind}/${id}`);
      const stage = join(pyDir, "dist");
      mkdirSync(stage, { recursive: true });
      writeFileSync(
        join(stage, `mistralai_capabilities_${kind}_${id}-1.2.3-py3-none-any.whl`),
        `${kind}/${id}`,
      );
    };

    await expect(buildPythonDistributions(root, "1.2.3", runner, quietLogger)).resolves.toEqual({
      built: 2,
      publicBuilt: 1,
    });

    expect(built.toSorted()).toEqual(["base/core", "feature/chat"]);
    expect(readdirSync(join(root, "dist", "py")).toSorted()).toEqual([
      "mistralai_capabilities_base_core-1.2.3-py3-none-any.whl",
      "mistralai_capabilities_feature_chat-1.2.3-py3-none-any.whl",
    ]);
    expect(readdirSync(join(root, "dist", "py-public"))).toEqual([
      "mistralai_capabilities_base_core-1.2.3-py3-none-any.whl",
    ]);
  });

  test("ignores a Python directory when the manifest does not declare a Python package", async () => {
    capability("feature", "typescript-only", true, undefined, ["ts"]);
    let called = false;

    await expect(
      buildPythonDistributions(
        root,
        "1.2.3",
        async () => {
          called = true;
        },
        quietLogger,
      ),
    ).resolves.toEqual({ built: 0, publicBuilt: 0 });
    expect(called).toBe(false);
  });

  test("fails before building when the public dependency graph is invalid", async () => {
    capability("feature", "public", true, ["private"]);
    capability("feature", "private", false);
    let called = false;

    await expect(
      buildPythonDistributions(
        root,
        "1.2.3",
        async () => {
          called = true;
        },
        quietLogger,
      ),
    ).rejects.toThrow("public capability eligibility failed");
    expect(called).toBe(false);
  });

  test("passes only the build-essential allowlist to untrusted build backends", () => {
    expect(
      pythonBuildEnvironment({
        PATH: "/bin",
        HOME: "/tmp/home",
        GEMFURY_UPLOAD_TOKEN: "must-not-cross",
        UV_PUBLISH_PASSWORD: "must-not-cross",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/tmp/home" });
  });
});
