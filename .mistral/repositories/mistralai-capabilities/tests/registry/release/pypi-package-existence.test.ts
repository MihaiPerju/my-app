import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  preflight,
  projectStates,
  projectUrl,
  publicProjectNames,
  type ProjectProbe,
} from "../../../scripts/release/pypi-package-existence";
import {
  normalizePyDistName,
  pyDistNameFromArtifact,
} from "../../../scripts/shared/capability-identity";

/** A probe answering from a fixed table, and the names it was asked about, in order. */
function stubProbe(statuses: Record<string, number>): ProjectProbe & { asked: string[] } {
  const asked: string[] = [];
  const probe = async (name: string): Promise<number> => {
    asked.push(name);
    const status = statuses[name];
    if (status === undefined) throw new Error(`unexpected probe for ${name}`);
    return status;
  };
  return Object.assign(probe, { asked });
}

function withDistDir(files: readonly string[], body: (directory: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "cap-pypi-preflight-"));
  try {
    const directory = join(root, "py-public");
    mkdirSync(directory);
    for (const file of files) writeFileSync(join(directory, file), "dist");
    body(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("pypi package existence", () => {
  // PEP 503 compares names with case, underscores, dots and runs of separators folded together, so
  // registering one spelling covers every other one and there is no permutation left to squat.
  test.each([
    ["mistralai-capabilities-chat", "mistralai-capabilities-chat"],
    ["MistralAI_Capabilities.Chat", "mistralai-capabilities-chat"],
    ["mistralai__capabilities--chat", "mistralai-capabilities-chat"],
    ["mistralai.capabilities_chat", "mistralai-capabilities-chat"],
  ] as const)("%s normalises to %s", (name, expected) => {
    expect(normalizePyDistName(name)).toBe(expected);
  });

  test.each([
    ["mistralai_capabilities_chat-0.1.3-py3-none-any.whl", "mistralai-capabilities-chat"],
    ["mistralai_capabilities_chat-0.1.3.tar.gz", "mistralai-capabilities-chat"],
    ["chat-1.0.0rc1-py3-none-any.whl", "chat"],
    ["Chat-1.0.0.tar.gz", "chat"],
  ] as const)("%s belongs to %s", (filename, expected) => {
    expect(pyDistNameFromArtifact(filename)).toBe(expected);
  });

  test.each([
    ["no version", "chat.tar.gz"],
    ["no name", "-0.1.3.tar.gz"],
    ["neither", "chat.whl"],
    ["no distribution suffix", "chat-0.1.3.zip"],
  ] as const)("a filename with %s is rejected", (_case, filename) => {
    expect(() => pyDistNameFromArtifact(filename)).toThrow("cannot read a distribution name");
  });

  test("a project built as both a wheel and an sdist is probed once, and other files are ignored", () => {
    withDistDir(
      [
        "mistralai_capabilities_registry-0.1.3-py3-none-any.whl",
        "mistralai_capabilities_registry-0.1.3.tar.gz",
        "mistralai_capabilities_chat-0.1.3-py3-none-any.whl",
        "README.md",
      ],
      (directory) => {
        expect(publicProjectNames(directory)).toEqual([
          "mistralai-capabilities-chat",
          "mistralai-capabilities-registry",
        ]);
      },
    );
  });

  // build-python.ts states an empty public set as an empty directory, and an artifact upload is a
  // zip built from a file list, so the directory does not survive the round trip. Both spellings of
  // "nothing to publish" have to reach the same answer the publish step reaches.
  test.each([
    ["an absent directory", false],
    ["an empty directory", true],
  ] as const)("%s has no projects to check", (_case, materialize) => {
    const root = mkdtempSync(join(tmpdir(), "cap-pypi-preflight-"));
    try {
      const directory = join(root, "py-public");
      if (materialize) mkdirSync(directory);

      expect(publicProjectNames(directory)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a project name is escaped so pypi.org answers for the project, not a path", () => {
    expect(projectUrl("mistralai-capabilities-chat")).toBe(
      "https://pypi.org/pypi/mistralai-capabilities-chat/json",
    );
  });

  test.each([
    ["every project already held", { a: 200, b: 200 }, ["held", "held"]],
    ["one project new", { a: 200, b: 404 }, ["held", "new"]],
    ["every project new", { a: 404, b: 404 }, ["new", "new"]],
  ] as const)("%s", async (_case, statuses, expected) => {
    const probe = stubProbe(statuses);

    expect([...(await projectStates(["a", "b"], probe)).values()]).toEqual([...expected]);
    expect(probe.asked).toEqual(["a", "b"]);
  });

  // A status the run cannot read as either answer would put a wrong list in front of whoever
  // approves the upload, so it fails the job instead.
  test.each([
    ["rate limited", 429],
    ["registry outage", 503],
    ["redirect", 301],
    ["forbidden", 403],
  ] as const)("%s fails the preflight rather than being classified", async (_c, status) => {
    await expect(projectStates(["a"], stubProbe({ a: status }))).rejects.toThrow(
      `pypi.org answered ${status} for a`,
    );
  });

  // A pending publisher does not create the project, so a name the service user has registered
  // correctly still answers 404. Failing on that would block every capability's first release.
  test.each([
    ["a first release, claiming both names", { a: 404, b: 404 }, true],
    ["a capability that is new alongside one that is not", { a: 200, b: 404 }, true],
    ["a repeat release of established projects", { a: 200, b: 200 }, false],
  ] as const)("%s passes", async (_case, statuses, warns) => {
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    try {
      await preflight(["a", "b"], stubProbe(statuses));
    } finally {
      console.log = log;
    }

    expect(logged.some((line) => line.startsWith("::warning::"))).toBe(warns);
  });

  test("the warning names every project the run would claim", async () => {
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    try {
      await preflight(["a", "b", "c"], stubProbe({ a: 404, b: 200, c: 404 }));
    } finally {
      console.log = log;
    }

    const warning = logged.find((line) => line.startsWith("::warning::"));
    expect(warning).toContain("2 new pypi.org project(s): a, c");
    expect(warning).not.toContain("b,");
  });

  test("a release with no public distributions asks pypi.org nothing", async () => {
    const probe = stubProbe({});

    expect(await preflight([], probe)).toEqual(new Map());
    expect(probe.asked).toEqual([]);
  });
});
