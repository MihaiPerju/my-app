"""The standalone pytest configuration must cover every workspace member that ships tests.

The testing NX target invokes pytest from the workspace root, where ``pytest.ini`` defines the
collection paths. This derives the expectation from ``[tool.uv.workspace] members`` rather than
trusting the hand-maintained list.
"""

import tomllib
from pathlib import Path

# Find the workspace root by walking up from this file until we find a pyproject.toml
# with [tool.uv.workspace] members
REPO = Path(__file__).resolve().parents[1]
current = REPO
while True:
    pyproject_path = current / "pyproject.toml"
    if pyproject_path.is_file():
        try:
            content = tomllib.loads(pyproject_path.read_text())
            tool = content.get("tool", {})
            uv = tool.get("uv", {})
            if "tool" in content and "uv" in tool and "workspace" in uv:
                REPO = current
                break
        except Exception:
            pass
    parent = current.parent
    if current == parent:
        break
    current = parent

PYPROJECT = tomllib.loads((REPO / "pyproject.toml").read_text())
MEMBER_GLOBS = PYPROJECT["tool"]["uv"]["workspace"]["members"]

# pytest.ini should be at the workspace root (copied from tooling/testing template in generated apps)
# In the repo, it's at capabilities/tooling/testing/template/pytest.ini
# In a generated app, it would be at the workspace root
pytest_ini_path = REPO / "pytest.ini"
if not pytest_ini_path.is_file():
    # Fallback: in the repo, pytest.ini is in the testing capability template
    testing_pytest = REPO / "capabilities" / "tooling" / "testing" / "template" / "pytest.ini"
    if testing_pytest.is_file():
        pytest_ini_path = testing_pytest
    else:
        # In a generated app without the testing capability, pytest.ini is at the workspace root
        # which should have been copied from the testing capability during app generation
        pytest_ini_path = REPO / "pytest.ini"
TESTPATHS = [
    line.strip()
    for line in pytest_ini_path.read_text().splitlines()
    if line.startswith("    ") and not line.lstrip().startswith("#")
]


def _collected() -> set[str]:
    """The directories pytest collects: each testpath expanded as the glob pytest treats it as."""
    return {path.relative_to(REPO).as_posix() for pattern in TESTPATHS for path in REPO.glob(pattern) if path.is_dir()}


def _members() -> list[str]:
    """The workspace members, expanded the way uv expands `[tool.uv.workspace] members`.

    `members` is globs, so the set follows capability selection with no hand-editing. A glob-matched
    dir is a member only when it carries a `pyproject.toml`, which keeps the TS-only `apps/web` out
    of these Python-workspace checks.
    """
    return [
        path.relative_to(REPO).as_posix()
        for pattern in MEMBER_GLOBS
        for path in sorted(REPO.glob(pattern))
        if (path / "pyproject.toml").is_file()
    ]


MEMBERS = _members()


def test_every_member_with_tests_is_in_testpaths() -> None:
    expected = {f"{m}/tests" for m in MEMBERS if (REPO / m / "tests").is_dir()}

    assert expected - _collected() == set()


def test_no_testpath_names_a_fixed_capability_package() -> None:
    # A literal `packages/py/<name>/tests` is absent from every selection that does not install
    # `<name>`, and misses any package the app adds. Globs follow the workspace instead.
    fixed = [path for path in TESTPATHS if path != "tests" and "*" not in path]

    assert fixed == []
