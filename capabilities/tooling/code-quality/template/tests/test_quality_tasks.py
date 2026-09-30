"""Behavioral tests for the code-quality NX targets and their backing ``tools/quality.sh``.

The invoke task module became ``tools/quality.sh`` (subcommand dispatch) plus a ``quality`` NX
project (``tasks/quality/project.json``). These pin the same contracts: the target surface, the
file-presence discovery (``py-targets`` / ``shell-scripts`` / ``dockerfiles``), and that an
inapplicable check skips rather than fails. They drive the real shell in a synthetic tree, so they
exercise the code the app actually runs — not a reimplementation of it.
"""

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
QUALITY_SH = REPO / "tools" / "quality.sh"
PROJECT = json.loads((REPO / "tasks" / "quality" / "project.json").read_text())
BASH = shutil.which("bash") or "/bin/bash"


def _run(subcommand: str, cwd: Path, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(QUALITY_SH), subcommand],
        cwd=cwd,
        capture_output=True,
        text=True,
        env=env,
    )


def _write(path: Path, text: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_project_exposes_the_quality_target_set() -> None:
    # Each concern owns a `check` target that `bunx nx run-many --target=check` aggregates, so the full
    # gate stays discovery-driven with no central list. The atomic targets drive the backing script;
    # `check` is a graph aggregator that dependsOn them (no nested nx), and `check-ts` is the TS half
    # of the gate (the root `check` script builds first, so it needs no build of its own).
    assert set(PROJECT["targets"]) == {
        "lint",
        "fmt",
        "fmt-check",
        "typecheck",
        "audit",
        "lint-shell",
        "lint-docker",
        "check-ts",
        "fix",
        "check",
    }
    for name, target in PROJECT["targets"].items():
        assert target["executor"] == "nx:run-commands"
        if name == "check":
            assert target["dependsOn"] == [
                "lint",
                "fmt-check",
                "typecheck",
                "audit",
                "lint-shell",
                "lint-docker",
                "check-ts",
            ]
        else:
            assert "tools/quality.sh" in target["options"]["command"]


def test_python_targets_follow_the_workspace_layout(tmp_path) -> None:
    _write(tmp_path / "packages/py/utils/src/__init__.py")
    _write(tmp_path / "packages/py/db/src/__init__.py")
    _write(tmp_path / "apps/api/pyproject.toml")
    _write(tmp_path / "apps/api/src/__init__.py")
    _write(tmp_path / "apps/web/src/index.ts")  # TS app: no pyproject -> excluded
    targets = set(_run("py-targets", tmp_path).stdout.split())
    assert targets == {"packages/py/utils/src", "packages/py/db/src", "apps/api/src"}


def test_shell_and_docker_discovery_ignores_vendored_trees(tmp_path) -> None:
    _write(tmp_path / "tools/smoke.sh")
    _write(tmp_path / "node_modules/pkg/vendored.sh")
    _write(tmp_path / "deploy/docker/Dockerfile.api")
    _write(tmp_path / "node_modules/pkg/Dockerfile")
    assert _run("shell-scripts", tmp_path).stdout.split() == ["tools/smoke.sh"]
    assert _run("dockerfiles", tmp_path).stdout.split() == ["deploy/docker/Dockerfile.api"]


def test_inapplicable_steps_skip_and_run_nothing(tmp_path) -> None:
    # An empty app: no pyproject, lockfiles, shell scripts, or Dockerfiles. Each atomic gate step
    # must skip explicitly and exit 0, never fail.
    for step in ("lint", "fmt-check", "typecheck", "audit", "lint-shell", "lint-docker"):
        result = _run(step, tmp_path)
        assert result.returncode == 0, result.stderr
        assert f"SKIPPED {step}" in result.stdout


def test_applicable_check_with_missing_tool_fails_with_guidance(tmp_path) -> None:
    # A Python workspace is present but uv is not on PATH: the step is applicable, so it must fail
    # with install guidance rather than skip. A restricted PATH hides uv (command -v is a builtin).
    _write(tmp_path / "pyproject.toml", "[project]\nname = 'x'\n")
    result = _run("lint", tmp_path, env={"PATH": "/nonexistent"})
    assert result.returncode != 0
    assert "install" in result.stderr.lower()


def test_lint_docker_lints_every_dockerfile_where_the_committed_config_is_read(tmp_path) -> None:
    # hadolint reads .hadolint.yaml from its working directory and never in stdin mode
    # (`hadolint -`), which is how the DL3008 policy used to be unreachable. A recording `docker`
    # proves the files are linted by path, in one run, from the mounted workspace root.
    _write(tmp_path / "deploy/docker/Dockerfile.api")
    _write(tmp_path / "deploy/docker/Dockerfile.worker")
    log = tmp_path / "docker.args"
    _write(tmp_path / "bin/docker", f'#!/bin/sh\nprintf "%s\\n" "$@" > "{log}"\n')
    (tmp_path / "bin/docker").chmod(0o755)

    result = _run("lint-docker", tmp_path, env={"PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin"})

    assert result.returncode == 0, result.stderr
    args = log.read_text().splitlines()
    assert f"{tmp_path}:/workspace:ro" in args
    assert args[args.index("-w") + 1] == "/workspace"
    assert "-" not in args
    assert args[-2:] == ["deploy/docker/Dockerfile.api", "deploy/docker/Dockerfile.worker"]


def test_the_shipped_linter_policies_are_where_the_linters_look() -> None:
    # shellcheck walks up from each script to find .shellcheckrc; hadolint reads .hadolint.yaml from
    # the workspace root it runs in. Both ship at the app root beside this capability's tools.
    assert "source-path=SCRIPTDIR" in (REPO / ".shellcheckrc").read_text()
    assert "DL3008" in (REPO / ".hadolint.yaml").read_text()
