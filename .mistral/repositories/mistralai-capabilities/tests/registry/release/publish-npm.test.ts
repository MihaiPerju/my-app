/**
 * Behavioural tests for the npm publish idempotency classifier.
 *
 * `publish-npm.ts` re-runs must be idempotent: a version already on the registry is a skip, not a
 * failure. The risk is an `isNpmAlreadyPublished` that is too generous, because a bare "already
 * exists" substring can appear in an unrelated failure and turn a real upload error green.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { CommandResult } from "../../../scripts/release/execute-npm-plan";
import { isNpmAlreadyPublished, publishNpmPackages } from "../../../scripts/release/publish-npm";
import { OUT_DIR } from "../../../scripts/release/publish-plan";

function result(exitCode: number, stderr = "", stdout = ""): CommandResult {
  return { exitCode, stderr, stdout };
}

describe("isNpmAlreadyPublished", () => {
  test("a genuine version conflict is a skip", () => {
    // npm's own duplicate-publish signals.
    expect(isNpmAlreadyPublished("npm error code EPUBLISHCONFLICT")).toBe(true);
    expect(
      isNpmAlreadyPublished("You cannot publish over the previously published versions: 1.2.3."),
    ).toBe(true);
    // Gemfury's npm host: a bare `409 Conflict` on the push.
    expect(isNpmAlreadyPublished("npm error 409 Conflict - PUT https://npm.fury.io/...")).toBe(
      true,
    );
    // Gemfury's other duplicate-version reply -- a 400, not a 409, with this body.
    expect(
      isNpmAlreadyPublished(
        "400 Bad Request: https://npm.fury.io/mistralai/@mistralai-capabilities%2fcore\n - Version already exists",
      ),
    ).toBe(true);
    // Case-insensitive: the same signals however the registry cased them.
    expect(isNpmAlreadyPublished("HTTPError: 409 CONFLICT")).toBe(true);
    expect(isNpmAlreadyPublished("Cannot Publish Over the previously published version")).toBe(
      true,
    );
  });

  test("an unrelated failure that merely contains 'already exists/published' is NOT a skip", () => {
    // The false-green bug: any of these would have been masked as an idempotent
    // skip by a bare-substring classifier, hiding a real, unretried upload error.
    expect(
      isNpmAlreadyPublished("500 Internal Server Error: asset already exists in storage"),
    ).toBe(false);
    expect(isNpmAlreadyPublished("this version was already published somewhere else")).toBe(false);
    expect(isNpmAlreadyPublished("npm error 403 Forbidden - bad or missing auth token")).toBe(
      false,
    );
    // A 409 that is NOT a publish conflict (e.g. a byte count) must not match.
    expect(isNpmAlreadyPublished("wrote 409 bytes to the tarball, then the upload timed out")).toBe(
      false,
    );
    expect(isNpmAlreadyPublished("npm error 404 Not Found - the registry has no such scope")).toBe(
      false,
    );
    expect(isNpmAlreadyPublished("")).toBe(false);
  });

  test("the shared executor checks exact versions before publishing", async () => {
    const commands: string[][] = [];
    const logger = { log: () => {}, warn: () => {}, error: () => {} };
    const entries = [
      { name: "@mistralai-capabilities/base-core", version: "1.2.3", tarball: "core.tgz" },
      {
        name: "@mistralai-capabilities/feature-chat",
        version: "1.2.4-rc7",
        tarball: "chat.tgz",
      },
    ];

    await expect(
      publishNpmPackages(
        entries,
        "https://npm.example.test/",
        async (command) => {
          commands.push([...command]);
          if (commands.length === 1) return result(1, "npm error E404");
          if (commands.length === 2) return result(0);
          return result(0, "", "1.2.4-rc7\n");
        },
        logger,
      ),
    ).resolves.toEqual({ succeeded: 1, skipped: 1 });
    expect(commands).toEqual([
      [
        "npm",
        "view",
        "@mistralai-capabilities/base-core@1.2.3",
        "version",
        "--registry",
        "https://npm.example.test/",
      ],
      [
        "npm",
        "publish",
        join(OUT_DIR, "core.tgz"),
        "--registry",
        "https://npm.example.test/",
        "--tag",
        "latest",
      ],
      [
        "npm",
        "view",
        "@mistralai-capabilities/feature-chat@1.2.4-rc7",
        "version",
        "--registry",
        "https://npm.example.test/",
      ],
    ]);
  });

  test("still treats a duplicate race after a missed existence check as a skip", async () => {
    let calls = 0;
    await expect(
      publishNpmPackages(
        [{ name: "@mistralai-capabilities/base-core", version: "1.2.3", tarball: "core.tgz" }],
        "https://npm.example.test/",
        async () => {
          calls++;
          return calls === 1
            ? result(1, "npm error E404")
            : result(1, "npm error EPUBLISHCONFLICT");
        },
        { log: () => {}, warn: () => {}, error: () => {} },
      ),
    ).resolves.toEqual({ succeeded: 0, skipped: 1 });
    expect(calls).toBe(2);
  });

  test("exit-0-shaped output is not consulted -- an empty/success body is not a conflict", () => {
    // The publish loop only calls the classifier AFTER a non-zero exit, so a
    // success-path body carrying no conflict signal must classify as "not a
    // conflict" and let the caller count it as a real failure to investigate.
    expect(isNpmAlreadyPublished("+ @mistralai-capabilities/core@1.2.3")).toBe(false);
  });
});
