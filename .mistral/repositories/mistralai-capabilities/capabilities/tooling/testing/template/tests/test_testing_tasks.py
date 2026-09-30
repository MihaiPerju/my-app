"""Behavioral tests for the testing NX targets and their backing ``tools/testing.sh``.

The invoke task module became ``tools/testing.sh`` (subcommand dispatch) plus a ``testing`` NX project
(``tasks/testing/project.json``). These pin the same contracts: the target surface, and the one seam
this capability owes the aggregated gate -- the Python suite always runs, but the web coverage ratchet
skips rather than fails when there is no ``apps/web`` (a supported ``core + testing`` composition has
none). The skip test drives the real shell in a synthetic tree, so it exercises the code the app
actually runs -- not a reimplementation of it.
"""

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TESTING_SH = REPO / "tools" / "testing.sh"
PROJECT = json.loads((REPO / "tasks" / "testing" / "project.json").read_text())
BASH = shutil.which("bash") or "/bin/bash"


def _run(subcommand: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(TESTING_SH), subcommand],
        cwd=cwd,
        capture_output=True,
        text=True,
    )


def test_project_exposes_the_testing_target_set() -> None:
    # `check` IS here: each concern owns a `check` target that `bunx nx run-many --target=check`
    # aggregates, so the full gate stays discovery-driven with no central list. Every target drives
    # the backing script -- the single home of the logic.
    assert set(PROJECT["targets"]) == {"test", "test-cov", "test-web-cov", "check"}
    for target in PROJECT["targets"].values():
        assert target["executor"] == "nx:run-commands"
        assert "tools/testing.sh" in target["options"]["command"]


def test_web_coverage_skips_without_a_web_app(tmp_path) -> None:
    # A `core + testing` app: no apps/web. The web ratchet must skip explicitly and exit 0 -- issuing
    # no bun/coverage-gate command -- rather than fail when the aggregated `check` runs it.
    result = _run("test-web-cov", tmp_path)
    assert result.returncode == 0, result.stderr
    assert "SKIPPED test-web-cov" in result.stdout


def test_coverage_measures_the_python_roots_that_exist(tmp_path) -> None:
    # Coverage follows the workspace layout, not a fixed list: a root whose capability is not
    # installed is never named (the old list gave "Module packages/py/evals/src was never imported"),
    # and a package the app adds is measured without editing any config.
    for root in ("packages/py/utils/src", "packages/py/mine/src", "apps/api/src", "apps/web/src"):
        (tmp_path / root).mkdir(parents=True)
    (tmp_path / "packages/py/testing").mkdir(parents=True)
    (tmp_path / "apps/api/pyproject.toml").write_text("")

    result = _run("cov-sources", tmp_path)

    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == [
        "--cov=packages/py/mine/src",
        "--cov=packages/py/utils/src",
        "--cov=apps/api/src",
    ]


def test_the_web_gate_counts_only_the_suites_own_source(tmp_path) -> None:
    # bun's lcov lists every file the tests load. A workspace library reached through `../../`
    # (the vendored markdown parser, once chat is installed) has its own tests and must not decide
    # the web app's number: here it would drag 3/4 own lines (75%) down to 3/12 (25%).
    lcov = tmp_path / "lcov.info"
    lcov.write_text(
        "SF:src/own.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,0\nend_of_record\n"
        "SF:../../packages/ts/markdown/src/parse.ts\n" + "".join(f"DA:{n},0\n" for n in range(1, 9)) + "end_of_record\n"
    )

    result = subprocess.run(
        [BASH, str(REPO / "tools" / "coverage-gate.sh"), str(lcov), "56"],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "3/4 lines covered (75.00%)" in result.stdout
    assert "not gating 8 lines" in result.stdout


def test_coverage_floors_are_preserved() -> None:
    # The two ratchets are the reason this concern contributes to `check`; the floors are the gate.
    # Pin them against the shipped script so lowering one -- which stops it being a gate -- fails here.
    script = TESTING_SH.read_text()
    assert "--cov-fail-under=81" in script
    assert "apps/web/coverage/lcov.info" in script
    assert "WEB_COVERAGE_MIN=56" in script
