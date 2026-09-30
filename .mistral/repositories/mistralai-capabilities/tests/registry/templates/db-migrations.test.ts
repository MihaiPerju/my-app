/**
 * The Postgres schema a generated app starts with.
 *
 * The app-local `db` package is assembled from the capabilities that own tables: each drops its
 * model into `db/models/` and, beside it, the baseline revision that creates the table. When the
 * models moved out of `postgres` the revisions did not follow them, so every freshly generated app
 * booted with no `users` table and 500'd its first authenticated request. These tests hold the
 * pairing, the branch shape that lets any subset of owners coexist, and the `db:revision` tooling
 * that has to produce a revision the app's own gates accept.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  capabilityLocalIds,
  contributedPaths,
  identityOf,
  readJson,
  templateDir,
} from "../support/template-tree";
import { renderHbs, toLocalId } from "../support/selection";

const MODELS = /^packages\/py\/db\/src\/db\/models\/([^_/][^/]*)\.py$/;
const VERSIONS = /^packages\/py\/db\/src\/db\/migrations\/versions\/[^/]+\.py$/;

const read = (ref: string, rel: string): string =>
  readFileSync(join(templateDir(ref), rel), "utf8");

interface NxProject {
  readonly targets: Record<string, { options: { command: string; forwardAllArgs?: boolean } }>;
}

interface Revision {
  readonly owner: string;
  readonly file: string;
  readonly source: string;
}

const owners = capabilityLocalIds.map((ref) => {
  const paths = contributedPaths(ref);
  return {
    ref,
    models: paths.filter((rel) => MODELS.test(rel)),
    revisions: paths
      .filter((rel) => VERSIONS.test(rel))
      .map((rel): Revision => ({ owner: ref, file: rel, source: read(ref, rel) })),
  };
});
const revisions = owners.flatMap((owner) => owner.revisions);

const field = (source: string, name: string): string | undefined =>
  new RegExp(`^${name}: [^=]+= (.+)$`, "m").exec(source)?.[1]?.trim();

/** A capability id as an Alembic branch label: underscores, since `-` reads as a relative step. */
const label = (ref: string): string => identityOf(ref).id.replaceAll("-", "_");

describe("capability-owned baseline migrations", () => {
  test("every capability that ships a model also ships the revision creating its table", () => {
    const orphans = owners
      .filter((owner) => owner.models.length > 0)
      .flatMap((owner) => {
        const created = owner.revisions.map((revision) => revision.source).join("\n");
        return owner.models.flatMap((rel) => {
          const table = /__tablename__ = "([^"]+)"/.exec(read(owner.ref, rel))?.[1];
          if (table === undefined) return [];
          return new RegExp(String.raw`op\.create_table\(\s*"${table}"`).test(created)
            ? []
            : [`${owner.ref}: ${table}`];
        });
      });
    expect(orphans).toEqual([]);
  });

  test("each baseline roots its own branch, labelled with its capability", () => {
    // A shared chain cannot work: which owners are present varies per composition, so a baseline
    // naming another as its parent dangles the moment that owner is deselected.
    for (const { owner, file, source } of revisions) {
      expect({
        file: `${owner}:${basename(file)}`,
        down: field(source, "down_revision"),
        labels: field(source, "branch_labels"),
      }).toEqual({
        file: `${owner}:${basename(file)}`,
        down: "None",
        labels: `("${label(owner)}",)`,
      });
    }
  });

  test("revision ids are unique, owner-prefixed, fit alembic_version, and name their file", () => {
    const ids = revisions.map(({ owner, file, source }) => {
      const id = /^"(.+)"$/.exec(field(source, "revision") ?? "")?.[1] ?? "";
      expect(id.startsWith(`${label(owner)}_`)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(32);
      expect(basename(file).startsWith(id)).toBe(true);
      return id;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the migration set is always applied to every head", () => {
    // Several independent baselines are several heads; `upgrade head` refuses that outright.
    const initStep = read("postgres", "packages/py/cli/src/cli/commands/migrations.py");
    expect(initStep).toContain('command.upgrade(config, "heads")');
    expect(initStep).not.toContain('command.upgrade(config, "head")');
    expect(read("postgres", "tools/db.sh")).toContain("run_alembic upgrade heads");
  });
});

describe("db:revision output passes the app's own gates", () => {
  test("the revision template imports sqlmodel's types module, in ruff's import order", () => {
    // Autogenerate renders `sqlmodel.sql.sqltypes.AutoString`; importing bare `sqlmodel` leaves ty
    // reporting possibly-missing-submodule on every column, and `from alembic` before
    // `import sqlalchemy` is an I001.
    const mako = read("postgres", "packages/py/db/src/db/migrations/script.py.mako");
    const imports = mako.split("\n").filter((line) => /^(import|from) /.test(line));
    expect(imports).toEqual([
      "from collections.abc import Sequence",
      "import sqlalchemy as sa",
      "import sqlmodel.sql.sqltypes",
      "from alembic import op",
    ]);
  });

  test("the revision template types down_revision for a revision with several parents", () => {
    // A revision based on several capability heads renders a tuple here; `str | None` is a ty
    // invalid-assignment in the first revision an app with two table owners generates.
    const mako = read("postgres", "packages/py/db/src/db/migrations/script.py.mako");
    expect(mako).toContain("down_revision: str | Sequence[str] | None = ${repr(down_revision)}");
  });

  const alembicIni = (present: string[]): string =>
    renderHbs(read("postgres", "packages/py/db/alembic.ini.hbs"), new Set(present.map(toLocalId)));

  test("post-write hooks run ruff check --fix before ruff format", () => {
    const ini = alembicIni(["core", "postgres", "code-quality"]);
    expect(ini).toMatch(/^hooks = ruff_fix, ruff_format$/m);
    expect(ini).toMatch(/^ruff_fix\.options = check --fix REVISION_SCRIPT_FILENAME$/m);
    expect(ini).toMatch(/^ruff_format\.options = format REVISION_SCRIPT_FILENAME$/m);
  });

  test("an app without code-quality, which alone installs ruff, gets no ruff hooks", () => {
    // Alembic runs an `exec` hook after writing the revision; with no `ruff` on PATH it raises
    // FileNotFoundError, so db:revision failed in every app generated without code-quality.
    const ini = alembicIni(["core", "postgres"]);
    expect(ini).not.toContain("[post_write_hooks]");
    expect(ini).not.toContain("ruff");
    expect(ini).toMatch(/^script_location = src\/db\/migrations$/m);
    expect(ini).toContain("[loggers]");
  });

  test("the Nx revision target forwards the caller's arguments rather than interpolating one", () => {
    // `{args.message}` drops positional words, and Nx forwards nothing else once a command
    // interpolates an argument.
    const project = readJson<NxProject>(
      join(templateDir("postgres"), "packages/py/db/project.json"),
    );
    const revision = project.targets["revision"]!.options;
    expect(revision.command).toBe("bash tools/db.sh revision");
    expect(revision.forwardAllArgs).toBe(true);
  });
});

interface RevisionRun {
  readonly status: number | null;
  readonly calls: string[];
}

/** Run `db.sh revision <args>` with a stub `tools/uv.sh` that logs each alembic call. */
function runDbRevision(args: string[], heads = 1): RevisionRun {
  const app = mkdtempSync(join(tmpdir(), "db-sh-"));
  try {
    mkdirSync(join(app, "tools"));
    copyFileSync(join(templateDir("postgres"), "tools", "db.sh"), join(app, "tools", "db.sh"));
    copyFileSync(join(templateDir("core"), "tools", "lib.sh"), join(app, "tools", "lib.sh"));
    const log = join(app, "calls.log");
    writeFileSync(
      join(app, "tools", "uv.sh"),
      [
        "shift 4  # run --no-sync --directory <dir>",
        "shift    # alembic",
        `printf '%s\\n' "$*" >> '${log}'`,
        `if [ "$1" = heads ]; then for i in $(seq ${heads}); do echo "rev$i (head)"; done; fi`,
      ].join("\n"),
    );
    writeFileSync(log, "");
    const run = spawnSync("bash", ["tools/db.sh", "revision", ...args], {
      cwd: app,
      encoding: "utf8",
    });
    return {
      status: run.status,
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

describe("tools/db.sh revision", () => {
  const forms: [string, string[]][] = [
    ["--message <words>", ["--message", "initial schema"]],
    ["--message=<words>", ["--message=initial schema"]],
    ["-m <words>", ["-m", "initial schema"]],
    ["bare words after --", ["initial", "schema"]],
    ['Nx --args="--message=initial schema", split at the space', ["--message=initial", "schema"]],
  ];
  for (const [name, args] of forms) {
    test(`keeps the whole message: ${name}`, () => {
      const { status, calls } = runDbRevision(args);
      expect(status).toBe(0);
      expect(calls.at(-1)).toBe("revision --autogenerate -m initial schema");
    });
  }

  test("refuses to write a revision with no message", () => {
    const { status, calls } = runDbRevision([]);
    expect(status).toBe(2);
    expect(calls).toEqual([]);
  });

  test("bases the revision on every head when there are several", () => {
    // One file that merges the capability branches and carries the diff. A separate `alembic
    // merge` first would leave the database behind the new head, and autogenerate refuses that.
    const { status, calls } = runDbRevision(["--message", "add widgets"], 3);
    expect(status).toBe(0);
    expect(calls).toEqual(["heads", "revision --autogenerate --head heads -m add widgets"]);
  });

  test("uses the plain head when there is one", () => {
    expect(runDbRevision(["--message", "add widgets"]).calls).toEqual([
      "heads",
      "revision --autogenerate -m add widgets",
    ]);
  });
});

/**
 * Run `db.sh downgrade [rev]` with a stub `tools/uv.sh` that answers `alembic current` / `show`
 * the way Alembic 1.14-1.20 prints them, and logs each alembic call.
 */
function runDbDowngrade(args: string[], current: string, show = ""): RevisionRun {
  const app = mkdtempSync(join(tmpdir(), "db-sh-"));
  try {
    mkdirSync(join(app, "tools"));
    copyFileSync(join(templateDir("postgres"), "tools", "db.sh"), join(app, "tools", "db.sh"));
    copyFileSync(join(templateDir("core"), "tools", "lib.sh"), join(app, "tools", "lib.sh"));
    const log = join(app, "calls.log");
    writeFileSync(join(app, "current.txt"), current);
    writeFileSync(join(app, "show.txt"), show);
    writeFileSync(
      join(app, "tools", "uv.sh"),
      [
        "shift 4  # run --no-sync --directory <dir>",
        "shift    # alembic",
        `printf '%s\\n' "$*" >> '${log}'`,
        `case "$1" in current) cat '${join(app, "current.txt")}' ;; show) cat '${join(app, "show.txt")}' ;; esac`,
      ].join("\n"),
    );
    writeFileSync(log, "");
    const run = spawnSync("bash", ["tools/db.sh", "downgrade", ...args], {
      cwd: app,
      encoding: "utf8",
    });
    return {
      status: run.status,
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

describe("tools/db.sh downgrade", () => {
  test("steps back one revision on a linear chain", () => {
    const { status, calls } = runDbDowngrade([], "705803285aa2 (head)\n");
    expect(status).toBe(0);
    expect(calls).toEqual(["current", "downgrade -1"]);
  });

  test("steps back off a revision based on several capability heads", () => {
    // The first db:revision in an app with several table owners has every capability head as its
    // parent. Alembic answers `downgrade -1` from there with "Ambiguous walk"; naming any one parent
    // unapplies exactly that revision and leaves every capability baseline in place.
    const { status, calls } = runDbDowngrade(
      [],
      "a635461836e4 (head) (mergepoint)\n",
      [
        "Rev: a635461836e4 (head) (mergepoint)",
        "Merges: fastapi_auth_0001, fastapi_workflows_auth_0001, search_0001",
        "Branch names: search, fastapi_workflows_auth, fastapi_auth",
        "",
      ].join("\n"),
    );
    expect(status).toBe(0);
    expect(calls).toEqual(["current", "show a635461836e4", "downgrade fastapi_auth_0001"]);
  });

  test("passes an explicit target through untouched", () => {
    expect(runDbDowngrade(["base"], "a635461836e4 (head) (mergepoint)\n").calls).toEqual([
      "downgrade base",
    ]);
  });
});
