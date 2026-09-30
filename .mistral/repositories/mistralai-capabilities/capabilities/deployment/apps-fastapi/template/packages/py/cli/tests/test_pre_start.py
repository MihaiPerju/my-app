import subprocess
import sys
from importlib.machinery import ModuleSpec

import pytest
from cli.commands import pre_start


def _install(monkeypatch: pytest.MonkeyPatch, steps: set[str], fail: bool = False) -> list[list[str]]:
    ran: list[list[str]] = []

    def find_spec(name: str) -> ModuleSpec | None:
        return ModuleSpec(name, None) if name.removeprefix("cli.commands.") in steps else None

    def run(args: list[str], *, check: bool) -> subprocess.CompletedProcess[bytes]:
        ran.append(args)
        if fail and check:
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(pre_start, "find_spec", find_spec)
    monkeypatch.setattr(pre_start.subprocess, "run", run)
    return ran


@pytest.mark.parametrize(
    ("installed", "expected"),
    [
        ({"migrations"}, ["migrations"]),
        ({"migrations", "custom_rbac", "guardrail", "prompts", "agents"}, ["migrations"]),
        (set(), []),
    ],
)
def test_runs_the_installed_steps_in_order(
    monkeypatch: pytest.MonkeyPatch, installed: set[str], expected: list[str]
) -> None:
    ran = _install(monkeypatch, installed)
    pre_start.main()
    assert ran == [[sys.executable, "-m", "cli", step] for step in expected]


def test_a_failing_step_fails_pre_start(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, {"migrations"}, fail=True)
    with pytest.raises(subprocess.CalledProcessError):
        pre_start.main()
