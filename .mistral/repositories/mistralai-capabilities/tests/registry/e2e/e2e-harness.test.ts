/** Regression tests for the E2E harness's exit-code boundary and health classification. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { REGISTRY_ROOT } from "../support/template-tree";

const E2E_DIR = join(REGISTRY_ROOT, "scripts", "e2e");
const PACKAGE_TRANSPORT_SOURCE = readFileSync(join(E2E_DIR, "package_transport.py"), "utf8");

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

sys.path.insert(0, ${JSON.stringify(E2E_DIR)})
import e2e_harness as harness
import package_transport
import runtime_checks
`;

describe("generated-app E2E failure semantics", () => {
  test("the local package version is valid for npm and Python", () => {
    const version = /PACKAGE_VERSION = "([^"]+)"/.exec(PACKAGE_TRANSPORT_SOURCE)?.[1];
    // This shared release-candidate spelling is valid npm SemVer and PEP 440. In particular, do
    // not replace it with an arbitrary npm-only suffix: the CLI carries it into Python PEP 508
    // requirements in the generated pyproject.
    expect(version).toMatch(/^\d+\.\d+\.\d+-rc\d+$/);
  });

  test("--package-only reports the package-transport app it actually retained", () => {
    const result = pythonProbe(`${loadModules}
workdir = pathlib.Path("/tmp/e2e-run")
package_app = package_transport.kept_app_path(workdir, packages_only=True)
assert package_app == workdir / package_transport.PACKAGE_WORKDIR_NAME / harness.APP_NAME
assert package_transport.kept_app_path(workdir, packages_only=False).name == harness.APP_NAME
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("transport equivalence ignores only the CLI's acquisition-owned outputs", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    package_app = root / "package"
    git_app = root / "git"
    for app in (package_app, git_app):
        (app / "src").mkdir(parents=True)
        (app / "src" / "shared.py").write_text("same")
        (app / "package.json").write_text(app.name)
    (package_app / ".mistral").mkdir()
    (package_app / ".mistral" / "package-only").write_text("ignored")
    (git_app / "uv.lock").write_text("git transport lock")
    (git_app / "AGENTS.md").write_text("git transport instructions")
    package_transport.check_package_transport_equivalence(package_app, git_app)
assert harness.steps[-2:] == [
    ("PASS", "package transport: complete generated file surface matches git transport"),
    ("PASS", "package transport: generated template contents match git transport"),
], harness.steps
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("transport equivalence compares root dotenv values independent of order", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    package_app = root / "package"
    git_app = root / "git"
    package_app.mkdir()
    git_app.mkdir()
    (package_app / ".env").write_text("B=2\\nA=1\\n")
    (git_app / ".env").write_text("A=1\\nB=2\\n")
    package_transport.check_package_transport_equivalence(package_app, git_app)
    assert not harness.failures, harness.failures
    (git_app / ".env").write_text("A=1\\nB=changed\\n")
    package_transport.check_package_transport_equivalence(package_app, git_app)
    assert any("generated template contents" in failure for failure in harness.failures)
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("transport equivalence permits git-only dotenv declarations", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    package_app = root / "package"
    git_app = root / "git"
    package_app.mkdir()
    git_app.mkdir()
    (package_app / ".env").write_text("SHARED=same\\n")
    (git_app / ".env").write_text("GIT_ONLY=value\\nSHARED=same\\n")
    package_transport.check_package_transport_equivalence(package_app, git_app)
    assert not harness.failures, harness.failures
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("transport equivalence detects omitted and changed packaged templates", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    package_app = root / "package"
    git_app = root / "git"
    package_app.mkdir()
    git_app.mkdir()
    (package_app / "changed.py").write_text("package")
    (git_app / "changed.py").write_text("git")
    (git_app / "missing.py").write_text("missing")
    package_transport.check_package_transport_equivalence(package_app, git_app)
assert any("complete generated file surface" in failure for failure in harness.failures)
assert any("generated template contents" in failure for failure in harness.failures)
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("'No solution' is a deterministic resolver failure, not an environment outage", () => {
    const result = pythonProbe(`${loadModules}
assert harness.INFRA.search("Temporary failure in name resolution")
assert harness.INFRA.search("network is unreachable")
assert not harness.INFRA.search("No solution found when resolving dependencies")
assert not harness.INFRA.search("Network app_default Creating")
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("an environment fault cannot mask an earlier failed check", () => {
    const result = pythonProbe(`${loadModules}
harness.failures.append("deterministic regression")
try:
    harness.infra_exit("network unavailable")
except SystemExit as error:
    assert error.code == 1, error.code
else:
    raise AssertionError("infra_exit did not exit")
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("a health timeout is recorded as a failed assertion", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
runtime_checks.run = lambda *args, **kwargs: (True, "")
runtime_checks.wait_healthy = lambda: (False, "timed out")
with tempfile.TemporaryDirectory() as directory:
    runtime_checks.boot_and_health(pathlib.Path(directory))
assert any("/api/health" in failure for failure in harness.failures), harness.failures
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("boot uses an isolated Compose project and removes its volumes", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
import os
calls = []
runtime_checks.run = lambda command, cwd, env=None: (calls.append((command, env)) or True, "")
runtime_checks.wait_healthy = lambda: (True, "healthy")
os.environ.pop("MISTRAL_API_KEY", None)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    runtime_checks.boot_and_health(root)
    values = dict(line.split("=", 1) for line in (root / ".env").read_text().splitlines())
assert values["COMPOSE_PROJECT_NAME"].startswith("capability-e2e-")
assert values["DEPLOYMENT_NAME"] == values["COMPOSE_PROJECT_NAME"]
assert values["GUARDRAIL_SIMILARITY_ENABLED"] == "false"
assert calls[0][1]["COMPOSE_PROJECT_NAME"] == values["COMPOSE_PROJECT_NAME"]
assert calls[-1][0][-3:] == ["down", "--volumes", "--remove-orphans"], calls[-1]
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("boot keeps similarity seeding enabled when a live API key is supplied", () => {
    const result = pythonProbe(`${loadModules}
import os
import tempfile
runtime_checks.run = lambda *args, **kwargs: (True, "")
runtime_checks.wait_healthy = lambda: (True, "healthy")
os.environ["MISTRAL_API_KEY"] = "test-api-key"
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    runtime_checks.boot_and_health(root)
    values = dict(line.split("=", 1) for line in (root / ".env").read_text().splitlines())
assert values["MISTRAL_API_KEY"] == "test-api-key"
assert "GUARDRAIL_SIMILARITY_ENABLED" not in values
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("failed startup diagnostics inspect the isolated Compose project", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
calls = []
def fake_run(command, cwd, env=None):
    calls.append((command, env))
    if command[:4] == ["bunx", "nx", "run", "compose:up"]:
        return False, "startup failed"
    return True, "diagnostic output"
runtime_checks.run = fake_run
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    runtime_checks.boot_and_health(root)
    project = dict(line.split("=", 1) for line in (root / ".env").read_text().splitlines())[
        "COMPOSE_PROJECT_NAME"
    ]
diagnostics = [call for call in calls if "ps" in call[0] or "logs" in call[0]]
assert len(diagnostics) == 2, diagnostics
assert all(env and env["COMPOSE_PROJECT_NAME"] == project for _, env in diagnostics), diagnostics
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("health-timeout diagnostics inspect the isolated Compose project", () => {
    const result = pythonProbe(`${loadModules}
import tempfile
calls = []
runtime_checks.run = lambda command, cwd, env=None: (calls.append((command, env)) or True, "")
runtime_checks.wait_healthy = lambda: (False, "timed out")
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    runtime_checks.boot_and_health(root)
    project = dict(line.split("=", 1) for line in (root / ".env").read_text().splitlines())[
        "COMPOSE_PROJECT_NAME"
    ]
logs = [call for call in calls if "logs" in call[0]]
assert len(logs) == 1, logs
assert logs[0][1]["COMPOSE_PROJECT_NAME"] == project, logs
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("capability removal support rejects zero-exit unknown-command help", () => {
    const result = pythonProbe(`${loadModules}
import generated_app_checks
generated_app_checks.run = lambda *args, **kwargs: (
    True,
    'DESCRIPTION\\n  Scaffold and manage Mistral apps\\n\\nERRORS\\n  Unknown subcommand "capability" for "mistral apps"',
)
assert not generated_app_checks.supports_capability_remove("mistral", pathlib.Path("/tmp/app"))
generated_app_checks.run = lambda *args, **kwargs: (
    True,
    "DESCRIPTION\\n  Remove installed capabilities from this app.",
)
assert generated_app_checks.supports_capability_remove("mistral", pathlib.Path("/tmp/app"))
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("Compose removal expects activated integrations to leave with their root", () => {
    const result = pythonProbe(`${loadModules}
import generated_app_checks
import json
import tempfile
with tempfile.TemporaryDirectory() as directory:
    app = pathlib.Path(directory)
    (app / ".mistral").mkdir()
    installed = [
        "mistralai-capabilities/base/core",
        "mistralai-capabilities/deployment/docker-compose",
        "mistralai-capabilities/deployment/docker-compose-api",
    ]
    def write_state(values):
        (app / ".mistral" / "capabilities.json").write_text(json.dumps({
            "schemaVersion": 4,
            "installed": [{"capability": value} for value in values],
        }))
    write_state(installed)
    for rel in generated_app_checks.COMPOSE_REMOVAL_ASSETS:
        path = app / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("generated")
    generated_app_checks.supports_capability_remove = lambda *_: True
    def fake_run(*_):
        write_state(["mistralai-capabilities/base/core"])
        for rel in generated_app_checks.COMPOSE_REMOVAL_ASSETS:
            path = app / rel
            if rel != "deploy/compose/compose.yaml":
                path.unlink(missing_ok=True)
        return True, ""
    generated_app_checks.run = fake_run
    generated_app_checks.installed_capability_ids = harness.installed_capability_ids
    generated_app_checks.check = harness.check
    generated_app_checks.check_capability_removal("mistral", app)
    assert not harness.failures, harness.failures
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("the required workflow turns environment exit 75 into a failed job", () => {
    const workflow = readFileSync(
      join(REGISTRY_ROOT, ".github", "workflows", "generated-app-e2e.yaml"),
      "utf8",
    );
    const report = workflow.slice(workflow.indexOf("- name: Report"));
    expect(report).toMatch(/75\)[\s\S]*?exit 1/);
  });
});

describe("kind-qualified E2E identity contract", () => {
  test("selects ordinary roots and expects derived integrations to activate", () => {
    const result = pythonProbe(`${loadModules}
import json
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    harness.REGISTRY_ROOT = root
    (root / "registry.json").write_text(json.dumps({
        "id": "acme",
        "capabilities": [
            {"kind": "base", "id": "core"},
            {"kind": "deployment", "id": "compose"},
            {"kind": "deployment", "id": "compose-api", "activatedWhen": {"allOf": ["compose", "api"]}},
        ],
    }))
    assert harness.selection_root_capability_ids() == [
        "acme/base/core", "acme/deployment/compose"
    ]
`);
    expect(result.exitCode, result.output).toBe(0);
  });
  test.each(["capabilities", "plugins", "."])("derives duplicate-leaf roots under %s", (prefix) => {
    const result = pythonProbe(`${loadModules}
import json
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    harness.REGISTRY_ROOT = root
    prefix = ${JSON.stringify(prefix)}
    descriptor = {
        "descriptorVersion": 3,
        "id": "acme",
        "capabilities": [
            {"kind": "frontend", "id": "search"},
            {"kind": "feature", "id": "search"},
        ],
    }
    if prefix != "capabilities":
        descriptor["capabilitiesDir"] = prefix
    (root / "registry.json").write_text(json.dumps(descriptor))
    assert harness.capability_roots() == {
        "acme/frontend/search": root / prefix / "frontend" / "search",
        "acme/feature/search": root / prefix / "feature" / "search",
    }
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("reads sorted unique installed identities without collapsing duplicate leaves", () => {
    const result = pythonProbe(`${loadModules}
import json
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root / ".mistral").mkdir()
    (root / ".mistral" / "capabilities.json").write_text(json.dumps({
        "schemaVersion": 4,
        "installed": [{"capability": ref, "version": "0.0.0"} for ref in [
            "acme/frontend/search", "acme/feature/search", "acme/frontend/search",
        ]],
    }))
    assert harness.installed_capability_ids(root) == ["acme/feature/search", "acme/frontend/search"]
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test.each([
    "acme/search",
    "acme//search",
    "acme/feature/search/extra",
    "acme/../search",
    "acme/feature/..",
    "",
    null,
  ])("rejects malformed saved reference %j", (reference) => {
    const result = pythonProbe(`${loadModules}
import json
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root / ".mistral").mkdir()
    reference = json.loads(${JSON.stringify(JSON.stringify(reference))})
    (root / ".mistral" / "capabilities.json").write_text(json.dumps({
        "schemaVersion": 4, "installed": [{"capability": reference}],
    }))
    try:
        harness.installed_capability_ids(root)
    except ValueError as error:
        assert "invalid installed capability reference" in str(error)
    else:
        raise AssertionError("malformed saved identity was accepted")
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test.each([
    { capabilities: [{ id: "search" }] },
    { schemaVersion: 3, installed: [] },
    { schemaVersion: 4, capabilities: [] },
    { schemaVersion: 4, installed: {} },
  ])("rejects obsolete or malformed saved state %j", (state) => {
    const result = pythonProbe(`${loadModules}
import json
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root / ".mistral").mkdir()
    (root / ".mistral" / "capabilities.json").write_text(${JSON.stringify(JSON.stringify(state))})
    try:
        harness.installed_capability_ids(root)
    except ValueError:
        pass
    else:
        raise AssertionError("obsolete saved state was accepted")
`);
    expect(result.exitCode, result.output).toBe(0);
  });

  test("packed descriptor uses local npm and committed template sources", () => {
    const result = pythonProbe(`${loadModules}
import io
import json
import tarfile
import tempfile
with tempfile.TemporaryDirectory() as directory:
    archive = pathlib.Path(directory) / "registry.tgz"
    payload = json.dumps({"sources": {"ts": "old-npm", "py": "python-index", "git": "old-git"}}).encode()
    with tarfile.open(archive, "w:gz") as target:
        member = tarfile.TarInfo("package/registry.json")
        member.size = len(payload)
        target.addfile(member, io.BytesIO(payload))
    package_transport.rewrite_descriptor_source(archive, "http://localhost:1234/", "git+file:///committed-registry")
    with tarfile.open(archive, "r:gz") as source:
        descriptor = json.load(source.extractfile("package/registry.json"))
    assert descriptor["sources"] == {
        "ts": "http://localhost:1234/", "py": "python-index", "git": "git+file:///committed-registry",
    }
`);
    expect(result.exitCode, result.output).toBe(0);
  });
});
