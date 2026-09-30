"""Type-check coverage for the code-quality capability.

The ``typecheck`` NX target (owned by code-quality, backed by ``tools/quality.sh``) must cover every
Python workspace member, and ``ty.toml`` must name only the required-core roots: ty refuses to start
when a configured root is missing, so an optional capability's package listed there would break
type-checking for every app that did not select it. The discovered target set comes from
``quality.sh py-targets`` (the same command the target runs).
"""

import shutil
import subprocess
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PYPROJECT = tomllib.loads((REPO / "pyproject.toml").read_text())
TY_CONFIG = tomllib.loads((REPO / "ty.toml").read_text())
MEMBER_GLOBS = PYPROJECT["tool"]["uv"]["workspace"]["members"]
TY_ROOTS = TY_CONFIG["environment"]["root"]
BASH = shutil.which("bash") or "/bin/bash"

# The worker app contains path-loaded agent slots with flat imports. The root typecheck excludes
# that subtree; the `agents:typecheck` target checks it from its own import root.
DIRECTORY_SCOPED = "apps/worker/src/worker/agents"


def _members() -> list[str]:
    """The Python workspace members, expanded the way uv expands ``[tool.uv.workspace] members``.

    A glob-matched dir is a member only when it carries a ``pyproject.toml``, which keeps the TS-only
    ``apps/web`` out of these Python-workspace checks and follows capability selection with no editing.
    """
    return [
        path.relative_to(REPO).as_posix()
        for pattern in MEMBER_GLOBS
        for path in sorted(REPO.glob(pattern))
        if (path / "pyproject.toml").is_file()
    ]


def _py_targets() -> set[str]:
    """The ty targets the `typecheck` target actually checks — from `quality.sh py-targets`."""
    result = subprocess.run(
        [BASH, str(REPO / "tools" / "quality.sh"), "py-targets"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    )
    return set(result.stdout.split())


MEMBERS = _members()
TARGETS = _py_targets()


def test_every_member_with_src_is_type_checked() -> None:
    expected = {f"{m}/src" for m in MEMBERS if (REPO / m / "src").is_dir()}
    assert expected - TARGETS == set()


def test_no_ty_root_belongs_to_an_optional_capability() -> None:
    """One optional entry here and ty will not start at all, for any app without that capability.

    ``core`` is the only required capability, so its three packages are the only safe entries; the
    coverage test above is what keeps the rest checked through ``typecheck``'s file inference.
    """
    assert set(TY_ROOTS) == {"packages/py/utils/src", "packages/py/env/src"}


def test_every_ty_root_exists() -> None:
    """Unlike a testpath, every ty root must be on disk — ty exits rather than skipping a missing one."""
    missing = [root for root in TY_ROOTS if not (REPO / root).is_dir()]
    assert missing == []


def test_directory_scoped_agent_tree_is_excluded_from_the_root_check() -> None:
    assert DIRECTORY_SCOPED in TY_CONFIG["src"]["exclude"]
    assert DIRECTORY_SCOPED not in TY_ROOTS
    assert DIRECTORY_SCOPED not in TARGETS
