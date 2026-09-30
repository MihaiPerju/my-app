import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  capabilityDir,
  capabilityLocalIds,
  readJson,
  templateDir,
  walk,
} from "../support/template-tree";

/**
 * Nx targets that shell out to `python -m cli <command>` name a Typer command by string. Nothing
 * else ties the two together: a renamed command or a target added without its module fails only
 * when someone runs the target in a generated app. These checks resolve every such target to a
 * command a capability actually vendors, within the capability's own dependency closure, so the
 * target works in every app that can contain it.
 */

type Manifest = { dependencies?: string[] };
type Project = { targets?: Record<string, { options?: { command?: string } }> };

const leaf = (ref: string) => ref.split("/").at(-1)!;
const localIdOf = (ref: string) => capabilityLocalIds.find((id) => leaf(id) === leaf(ref))!;

const commandModules = (cap: string) =>
  walk(templateDir(cap)).filter(
    (path) =>
      path.endsWith(".py") &&
      basename(dirname(path)) === "commands" &&
      path.includes(join("cli", "src", "cli", "commands")) &&
      basename(path) !== "__init__.py",
  );

const commandsOf = (cap: string): Set<string> =>
  new Set(
    commandModules(cap).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/@app\.command\(\s*name="([^"]+)"/g)].map(
        (m) => m[1]!,
      ),
    ),
  );

const closure = (cap: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(cap)) return seen;
  seen.add(cap);
  const manifest = readJson<Manifest>(join(capabilityDir(cap), "capability.json"));
  for (const dep of manifest.dependencies ?? []) closure(localIdOf(dep), seen);
  return seen;
};

const cliTargets = (cap: string) =>
  walk(templateDir(cap))
    .filter((path) => basename(path) === "project.json")
    .flatMap((path) =>
      Object.entries(readJson<Project>(path).targets ?? {}).flatMap(([target, spec]) => {
        const match = (spec.options?.command ?? "").match(/python -m cli (\S+)/);
        return match ? [{ target, command: match[1]!, path }] : [];
      }),
    );

describe("nx targets that run `python -m cli <command>`", () => {
  const withTargets = capabilityLocalIds.filter((cap) => cliTargets(cap).length > 0);

  test("at least one capability ships such a target (the scan still finds them)", () => {
    expect(withTargets.length).toBeGreaterThan(0);
  });

  test.each(withTargets)(
    "%s: every target names a command vendored in its dependency closure",
    (cap) => {
      const available = new Set([...closure(cap)].flatMap((id) => [...commandsOf(id)]));
      const dangling = cliTargets(cap)
        .filter(({ command }) => !available.has(command))
        .map(({ target, command }) => `${target} -> ${command}`);
      expect(dangling).toEqual([]);
    },
  );

  test("every command module exposes the module-level Typer `app` the CLI mounts", () => {
    // `cli.main` imports every module in `cli.commands` and mounts `module.app`; a helper module
    // dropped there would crash every command at startup.
    const missing = capabilityLocalIds.flatMap((cap) =>
      commandModules(cap).filter(
        (path) => !/^app = typer\.Typer\(/m.test(readFileSync(path, "utf8")),
      ),
    );
    expect(missing).toEqual([]);
  });

  test("evals ships a corpus search eval next to the synthetic one", () => {
    // The synthetic `eval-search` never reads the app's corpus; the corpus track is the one that
    // grades the product, so losing its target would silently leave only the harness check.
    const targets = new Map(cliTargets("evals").map(({ target, command }) => [target, command]));
    expect(targets.get("eval-search")).toBe("eval-search");
    expect(targets.get("eval-search-corpus")).toBe("eval-search-corpus");
  });
});
