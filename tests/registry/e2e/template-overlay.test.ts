/** The composed-template gates (ruff and oxfmt) must rebuild the app tree the same way. */
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { REGISTRY_ROOT } from "../support/template-tree";

const E2E_DIR = join(REGISTRY_ROOT, "scripts", "e2e");

function pythonProbe(source: string) {
  const proc = Bun.spawnSync(["python3", "-c", source], {
    cwd: REGISTRY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

const loadModules = `
import pathlib
import sys
import tempfile

sys.path.insert(0, ${JSON.stringify(E2E_DIR)})
import fmt_templates
import lint_templates
import template_overlay
`;

describe("template overlay composition", () => {
  test("lint_templates and fmt_templates compose through the shared module", () => {
    const result = pythonProbe(`${loadModules}
assert lint_templates.compose is template_overlay.compose
assert fmt_templates.compose is template_overlay.compose
assert lint_templates.source_paths is template_overlay.source_paths
assert fmt_templates.source_paths is template_overlay.source_paths
assert lint_templates.RUFF_CONFIG.parent == template_overlay.CODE_QUALITY_TEMPLATE
assert fmt_templates.CODE_QUALITY == template_overlay.CODE_QUALITY_TEMPLATE
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("the oxfmt tree is exactly the ruff tree's apps/ and packages/, minus unrendered files", () => {
    const result = pythonProbe(`${loadModules}
with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
    full = template_overlay.compose(pathlib.Path(a))
    zoned = fmt_templates.compose_zones(pathlib.Path(b))
    expected = {
        path: owners
        for path, owners in full.items()
        if path.split("/", 1)[0] in fmt_templates.ZONES
        and fmt_templates.formatted_by_app(pathlib.PurePosixPath(path))
    }
    assert dict(zoned) == expected, sorted(set(zoned) ^ set(expected))[:5]
    assert expected, "no apps/ or packages/ template files found"
    for path in zoned:
        assert (pathlib.Path(a) / path).read_bytes() == (pathlib.Path(b) / path).read_bytes(), path
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("templates overlay in sorted order, the later one wins, and every writer owns the path", () => {
    const result = pythonProbe(`${loadModules}
with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as dest:
    repo = pathlib.Path(repo)
    for capability, body in (("feature/zeta", "zeta"), ("base/alpha", "alpha")):
        shared = repo / "capabilities" / capability / "template" / "packages" / "shared.txt"
        shared.parent.mkdir(parents=True)
        shared.write_text(body)
    (repo / "capabilities" / "base" / "alpha" / "template" / "README.md").write_text("root")
    template_overlay.REPO = repo
    template_overlay.CAPABILITIES = repo / "capabilities"
    owners = template_overlay.compose(pathlib.Path(dest))
    assert owners["packages/shared.txt"] == ["base/alpha", "feature/zeta"]
    assert (pathlib.Path(dest) / "packages" / "shared.txt").read_text() == "zeta"
    assert template_overlay.source_paths("packages/shared.txt", owners) == [
        "capabilities/base/alpha/template/packages/shared.txt",
        "capabilities/feature/zeta/template/packages/shared.txt",
    ]
    with tempfile.TemporaryDirectory() as zoned:
        assert set(template_overlay.compose(pathlib.Path(zoned), zones=("packages",))) == {"packages/shared.txt"}
`);
    expect(result.exitCode, result.output).toBe(0);
  });
});
