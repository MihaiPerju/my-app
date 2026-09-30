import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { closure, renderHbs } from "../support/selection";
import { templateDir } from "../support/template-tree";

const FASTAPI_ROOT = templateDir("fastapi");
const plainFiles = [
  "apps/api/src/api/main.py",
  "apps/api/src/api/routers/api/internal/health.py",
  "apps/api/tests/conftest.py",
] as const;
const packageRoots = [
  "apps/api/src/api/configure/__init__.py",
  "apps/api/src/api/lifespan/startup/__init__.py",
  "apps/api/src/api/lifespan/shutdown/__init__.py",
  "apps/api/src/api/health/report/__init__.py",
  "apps/api/src/api/health/ready/__init__.py",
  "apps/api/src/api/health/metadata/__init__.py",
] as const;

describe("FastAPI integrations are file-discovered", () => {
  test("the host, health router, and test support are static", () => {
    for (const path of plainFiles) {
      expect(existsSync(join(FASTAPI_ROOT, path))).toBe(true);
      expect(existsSync(join(FASTAPI_ROOT, `${path}.hbs`))).toBe(false);
    }
    expect(existsSync(join(FASTAPI_ROOT, "apps/api/pyproject.toml.hbs"))).toBe(true);
  });

  test("FastAPI owns every empty discovery package root", () => {
    for (const path of packageRoots) expect(existsSync(join(FASTAPI_ROOT, path)), path).toBe(true);
  });

  test("each integration owns only uniquely named dropped hooks", () => {
    const expected = {
      "fastapi-postgres": [
        "apps/api/src/api/health/report/database.py",
        "apps/api/src/api/health/ready/database.py",
        "apps/api/src/api/lifespan/shutdown/database.py",
      ],
      "fastapi-auth": ["apps/api/src/api/configure/auth.py"],
      "fastapi-workflows": ["apps/api/src/api/health/metadata/deployment.py"],
      "fastapi-workflows-auth": [
        "apps/api/src/api/configure/workflows_auth.py",
        "apps/api/src/api/lifespan/startup/workflows_auth.py",
      ],
    } as const;
    for (const [owner, paths] of Object.entries(expected)) {
      for (const path of paths)
        expect(existsSync(join(templateDir(owner), path)), `${owner}/${path}`).toBe(true);
    }
  });

  test("only the API workspace dependency projection remains templated", () => {
    const source = readFileSync(join(FASTAPI_ROOT, "apps/api/pyproject.toml.hbs"), "utf8");
    const render = (selection: string[]) => renderHbs(source, closure(selection));
    expect(render(["fastapi"])).not.toContain('"db"');
    expect(render(["fastapi", "postgres"])).toContain('"db"');
    expect(render(["fastapi", "workflows"])).toContain('"workflows-app"');
  });

  test("generic host sources name no concrete integration", () => {
    const source = plainFiles
      .map((path) => readFileSync(join(FASTAPI_ROOT, path), "utf8"))
      .join("\n");
    for (const name of ["fastapi_auth", "fastapi_workflows_auth", "from db", "workflows_env"]) {
      expect(source).not.toContain(name);
    }
  });
});
