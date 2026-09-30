/** Descriptor freshness, dependency graph, shell, and package-zone invariants. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { buildReadme } from "../../../scripts/registry/build-docs";
import { buildDescriptor } from "../../../scripts/registry/build-registry";
import { capabilities, required, selectionClosures, toLocalId } from "../support/selection";
import { REGISTRY_ID } from "../support/registry-fixtures";
import {
  capabilityDir,
  capabilityLocalIds,
  identityOf,
  npmPkgNameFor,
  readJson,
  REGISTRY_ROOT,
  templateDir,
  walk,
} from "../support/template-tree";

// Taxonomy-table cell helpers, shared by the contract test that parses the committed README table.
const unwrapCell = (cell: string): string => cell.trim().replace(/^`|`$/g, "");
const tableCell = (row: string[], index: number): string => row.at(index) ?? "";
const depsCell = (cell: string): string[] => {
  const value = cell.trim();
  if (value === "—") return [];
  return value
    .split(",")
    .map((token) => unwrapCell(token))
    .toSorted();
};
// Split a Markdown table row into trimmed cells. `build-docs.ts` escapes a literal `|` inside a
// cell as `\|` so it cannot open a new column, so a raw `split("|")` would treat that escaped pipe
// as a boundary and shift every later column. Split on unescaped pipes only, then unescape.
const splitTableRow = (line: string): string[] =>
  line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));

describe("registry descriptor", () => {
  test("registry.json and capabilities/ describe the same set", () => {
    const descriptor = readJson<{ capabilities: { id: string; kind: string }[] }>(
      join(REGISTRY_ROOT, "registry.json"),
    );
    expect(descriptor.capabilities.map((c) => `${c.kind}/${c.id}`).toSorted()).toEqual(
      capabilityLocalIds.toSorted(),
    );
  });

  // The id-set check above only compares ids, so editing a capability.json field the descriptor
  // carries (dependencies, packages, envVars, default, …) and forgetting `registry:build` leaves
  // the id set intact and slips past `bun run test` — caught only later by the separate CI
  // `registry:check` step. Re-run the canonical generator here (same pure function the CLI uses,
  // passed this repo root because it otherwise scans the process cwd) so the drift fails locally
  // too, in the same suite that already guards the graph.
  test("registry.json is regenerated from the current capabilities (not stale)", () => {
    const committed = readFileSync(join(REGISTRY_ROOT, "registry.json"), "utf8");
    expect(
      committed === buildDescriptor(REGISTRY_ROOT),
      "registry.json is stale — run `bun run registry:build` and commit it",
    ).toBe(true);
  });

  // The README's capabilities table is generated from the same capability.json scan, so a summary
  // or dependency edit that forgets `docs:build` drifts the same way registry.json does. Guard it in
  // the same suite (the CI `docs:check` step is the belt to this suspenders).
  test("README.md capabilities table is regenerated from the current capabilities (not stale)", async () => {
    const committed = readFileSync(join(REGISTRY_ROOT, "README.md"), "utf8");
    expect(
      committed === (await buildReadme(REGISTRY_ROOT)),
      "README.md capabilities table is stale — run `bun run docs:build` and commit it",
    ).toBe(true);
  });

  // The README taxonomy table is the top-level public contract for how a capability is classified
  // and selected. The freshness test above proves it matches the *generator*; this one parses the
  // *committed* table and checks every kind/required/default/dependency cell against the manifests
  // directly, so the table cannot silently misrepresent the registry even if the generator changed.
  test("the README taxonomy table matches the manifests for kind, required, default, and dependencies", () => {
    const readme = readFileSync(join(REGISTRY_ROOT, "README.md"), "utf8");
    const start = readme.indexOf("<!-- table:start -->");
    const end = readme.indexOf("<!-- table:end -->");
    expect(start, "README.md is missing the capabilities table markers").toBeGreaterThan(-1);
    expect(end, "README.md is missing the capabilities table markers").toBeGreaterThan(start);

    // Table rows are the pipe-delimited lines between the markers: row 0 is the header, row 1 is the
    // `---` separator, and the rest are data rows.
    const rows = readme
      .slice(start, end)
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) => splitTableRow(line));
    const header = rows.at(0) ?? [];
    const separator = rows.at(1) ?? [];
    const dataRows = rows.slice(2);

    expect(header).toEqual([
      "Capability",
      "Kind",
      "Required",
      "Default",
      "What it adds",
      "Depends on",
    ]);
    expect(separator.length > 0 && separator.every((token) => /^-+$/.test(token))).toBe(true);

    const tableIds = dataRows.map((row) => unwrapCell(tableCell(row, 0)));
    expect(tableIds.toSorted(), "the taxonomy table lists a different capability set").toEqual(
      capabilityLocalIds.toSorted(),
    );

    for (const row of dataRows) {
      const id = unwrapCell(tableCell(row, 0));
      const manifest = capabilities.get(id);
      expect(manifest, `${id}: unknown capability in the taxonomy table`).toBeDefined();
      if (!manifest) continue;
      expect(manifest.kind, `${id}: manifest has a kind`).toBeDefined();
      expect(unwrapCell(tableCell(row, 1)), `${id}: kind cell`).toBe(manifest.kind ?? "");
      expect(tableCell(row, 2), `${id}: required cell`).toBe(
        manifest.required === true ? "Yes" : "—",
      );
      expect(tableCell(row, 3), `${id}: default cell`).toBe(
        manifest.default === true ? "Yes" : "—",
      );
      expect(depsCell(tableCell(row, 5)), `${id}: depends-on cell`).toEqual(
        (manifest.dependencies ?? []).toSorted(),
      );
    }
  });

  // `build-docs.ts` escapes a literal `|` in the "What it adds" cell as `\|`. The taxonomy parser
  // above must not treat that as a column boundary, or a valid manifest description shifts the
  // later columns and misreads the dependency cell.
  test("splitTableRow keeps an escaped pipe inside its cell instead of opening a column", () => {
    const line = "| `x` | `feature` | — | — | Adds a\\|b filter | `core` |";
    expect(splitTableRow(line)).toEqual([
      "`x`",
      "`feature`",
      "—",
      "—",
      "Adds a|b filter",
      "`core`",
    ]);
  });

  test("every dependency names a real capability", () => {
    for (const [id, capability] of capabilities) {
      for (const dependency of capability.dependencies ?? []) {
        // Source deps may be bare (unambiguous) or `kind/id`; identityOf throws on unknown/ambiguous.
        expect(
          () => identityOf(dependency),
          `${id} depends on unknown "${dependency}"`,
        ).not.toThrow();
      }
    }
  });

  // A cycle is not a config typo: the CLI resolves dependencies transitively when `--yes` selects
  // everything, so a cycle either hangs the resolve or silently drops a capability.
  test("the dependency graph is acyclic", () => {
    const state = new Map<string, "visiting" | "done">();
    const cycles: string[] = [];

    const visit = (id: string, path: string[]): void => {
      if (state.get(id) === "done") return;
      if (state.get(id) === "visiting") {
        cycles.push([...path, id].join(" -> "));
        return;
      }
      state.set(id, "visiting");
      for (const dependency of capabilities.get(id)?.dependencies ?? []) {
        const dep = toLocalId(dependency);
        if (capabilities.has(dep)) visit(dep, [...path, id]);
      }
      state.set(id, "done");
    };

    for (const id of capabilityLocalIds) visit(id, []);
    expect(cycles).toEqual([]);
  });

  test("the exhaustive selection matrix does not silently shrink", () => {
    // Graph changes can legitimately change this number, but updating it forces the author to
    // review the new closure surface. Without a floor, a broken enumerator can register zero
    // parameterized cases and make every conditional-template suite vacuously green. Derived
    // activation widens the surface: a selection that makes every prerequisite of a hidden
    // integration effective also activates that integration.
    expect(selectionClosures).toHaveLength(79200);
  });

  test("the shell invariant holds: exactly one capability ships the app's root package.json", () => {
    const shells = capabilityLocalIds.filter(
      (id) =>
        existsSync(join(templateDir(id), "package.json")) ||
        existsSync(join(templateDir(id), "package.json.hbs")),
    );
    expect(shells).toHaveLength(1);
    expect(required, "exactly the shell capability must be required").toEqual(shells);
  });

  test("every code-bearing capability has its correctly named npm package", () => {
    for (const [id, capability] of capabilities) {
      // Template-only capabilities (deployment/tooling) declare no `"ts"` language and
      // ship no npm package.json — they are git-delivered. Only a code-bearing capability
      // owns a root package.json, which must be named for its descriptor id.
      if (!(capability.packages ?? []).includes("ts")) continue;
      const path = join(capabilityDir(id), "package.json");
      expect(existsSync(path), `${id}: missing package.json`).toBe(true);
      const manifest = readJson<{ name?: unknown }>(path);
      expect(manifest.name, `${id}: package name must be its kind-qualified npm name`).toBe(
        npmPkgNameFor(REGISTRY_ID, id),
      );
    }
  });

  // One direction only. A declared language whose zone is missing is a broken publish, but the
  // reverse is legitimate: `packages/*` members ship a `package/ts` without being capabilities at
  // all, and a template-only capability (`packages: []`) ships no zone because it is vendored
  // through `sources.git`. Every ts-PACKAGED capability declares `"ts"`, including the ones that
  // expose no library (core, agents, api, ...): the npm tarball is how that capability's
  // `template/` zone and `capability.json` reach an app installed from the npm registry, so a
  // packaged capability that skips it silently loses its glue templates and envVars there. See
  // the sibling test below.
  test("every declared package language has a zone on disk", () => {
    for (const [id, capability] of capabilities) {
      for (const lang of capability.packages ?? []) {
        const zone = join(capabilityDir(id), "package", lang);
        expect(existsSync(zone), `${id} declares "${lang}" but ships no package/${lang}`).toBe(
          true,
        );
      }
    }
  });

  // The regression guard for npm-installed apps. The CLI locates `template/` and `capability.json`
  // under the installed npm capability package, so any capability with package code must declare
  // `ts`; otherwise package-source generation silently loses its templates and envVars. Git-source
  // generation materializes the repository and would hide that defect.
  //
  // Template-only capabilities (deployment/tooling) declare NO package language: they publish no
  // npm or PyPI dist, so `sources.ts` cannot reach them and they are delivered through
  // `sources.git`, which vendors the whole repo subtree regardless. They are therefore exempt from
  // the `"ts"` requirement -- and MUST stay package-less, or they would publish an empty marker
  // package. A capability that declares any package language still owes `"ts"`.
  test("every code-bearing capability declares `ts`; template-only ones stay package-less", () => {
    for (const [id, capability] of capabilities) {
      const packages = capability.packages ?? [];
      if (packages.length === 0) {
        // Template-only: git-delivered. It must ship a template/ zone (its whole reason to exist)
        // and no package/ zone (which would imply an unpublished dist).
        expect(
          existsSync(join(templateDir(id), ".")) && !existsSync(join(capabilityDir(id), "package")),
          `${id} declares no package language, so it must ship a template/ zone and no package/ zone`,
        ).toBe(true);
        continue;
      }
      expect(
        packages,
        `${id} must declare "ts": without it an npm-installed app gets no template/ or capability.json`,
      ).toContain("ts");
    }
  });

  // Declaring `"ts"` gets the tarball installed, but npm and bun strip fixed filenames regardless
  // of `files` or `.templateignore`. A stripped file needs a `.hbs` carrier or an undotted spelling
  // that the CLI re-dots.
  test("no template zone ships a filename npm strips from published tarballs", () => {
    // npm's unconditional exclusion list, restricted to names that could plausibly be app content.
    // `.gitignore` is not dropped but RENAMED to `.npmignore`, which is just as lossy.
    const STRIPPED_BY_NPM = new Set([
      ".npmrc",
      ".gitignore",
      "package-lock.json",
      "npm-debug.log",
      ".DS_Store",
    ]);
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const dir = templateDir(id);
      if (!existsSync(dir)) continue;
      for (const abs of walk(dir)) {
        const rel = relative(dir, abs);
        const base = rel.split("/").at(-1) ?? "";
        if (STRIPPED_BY_NPM.has(base)) offenders.push(`${id}/template/${rel}`);
      }
    }
    expect(
      offenders,
      "npm strips these from every tarball, so ship an undotted carrier that the CLI re-dots",
    ).toEqual([]);
  });

  // `.npmrc` is rendered glue and gitignored in the generated app, so a fresh clone recreates it
  // from `.npmrc.example`. Keep each carrier byte-identical to that example.
  test("every .npmrc carrier and its .npmrc.example are byte-identical", () => {
    const zones = capabilityLocalIds
      .map((id) => templateDir(id))
      .filter((zone) => existsSync(join(zone, ".npmrc.hbs")));
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) {
      expect(readFileSync(join(zone, ".npmrc.hbs"), "utf8"), zone).toBe(
        readFileSync(join(zone, ".npmrc.example"), "utf8"),
      );
    }
  });
});
