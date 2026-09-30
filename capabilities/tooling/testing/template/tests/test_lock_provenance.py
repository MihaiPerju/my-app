"""Every locked package must come from the index that pyproject bound it to.

`index-strategy = "first-index"` makes index order decide provenance, and uv also reads indexes from
the environment and user config. A machine that registers the private index as a general one can
silently move packages between indexes. `[tool.uv.sources]` prevents this but is not self-checking.
This test compares the written lock against the bindings.
"""

import re
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PYPROJECT = tomllib.loads((REPO / "pyproject.toml").read_bytes().decode())
LOCK = tomllib.loads((REPO / "uv.lock").read_bytes().decode())


def _canonical(name: str) -> str:
    """PEP 503 normalisation — the lock writes canonical names, `[tool.uv.sources]` keys are free-form."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _members() -> list[Path]:
    """The root pyproject plus every workspace member's, since uv honours the bindings in both.

    Each capability binds its own members' requirements (`mistralai-guardrails` in the guardrailing
    member, for one), leaving the root with none. Reading only the root would call those unbound and
    fail on them.
    """
    root = PYPROJECT["tool"]["uv"]["workspace"]["members"]
    paths = [REPO]
    for member in root:
        paths.extend(sorted(REPO.glob(member)) if "*" in member else [REPO / member])
    return [p / "pyproject.toml" for p in paths if (p / "pyproject.toml").is_file()]


def _bindings() -> tuple[dict[str, str], str]:
    """(canonical package name -> the URL of its bound index, URL of the default index)."""
    urls: dict[str, str] = {}
    sources: dict[str, str] = {}
    default = ""
    for path in _members():
        uv = tomllib.loads(path.read_bytes().decode()).get("tool", {}).get("uv", {})
        for index in uv.get("index", []):
            urls[index["name"]] = index["url"]
            if index.get("default"):
                default = index["url"]
        for name, source in uv.get("sources", {}).items():
            if isinstance(source, dict) and "index" in source:
                sources[_canonical(name)] = source["index"]
    return {name: urls[index] for name, index in sources.items() if index in urls}, default


def _locked() -> dict[str, str]:
    """Canonical package name -> the registry it was locked from.

    Workspace members and git/path/URL dependencies have no `registry` key; they are not served by
    an index, so there is nothing to bind them to.
    """
    return {
        _canonical(package["name"]): package["source"]["registry"]
        for package in LOCK["package"]
        if "registry" in package.get("source", {})
    }


BOUND, DEFAULT_INDEX = _bindings()
LOCKED = _locked()


def test_the_workspace_declares_a_default_index() -> None:
    # Everything below reads "not the default index" as "private", so an absent default would make
    # the whole file vacuous rather than failing.
    assert DEFAULT_INDEX == "https://pypi.org/simple"


def test_no_package_is_served_by_an_index_it_was_not_bound_to() -> None:
    # The dependency-confusion direction: a name nobody pinned, arriving from the private index.
    # Under `first-index` this is what a stray general index looks like from the outside.
    unbound = {name: registry for name, registry in LOCKED.items() if registry != DEFAULT_INDEX and name not in BOUND}

    assert unbound == {}


def test_every_bound_package_came_from_the_index_it_was_bound_to() -> None:
    # Both directions at once: a private name that silently fell through to public PyPI (the 404
    # squatting surface), and a dual-published name pinned to PyPI that the private index served
    # instead.
    misrouted = {
        name: {"locked": LOCKED[name], "bound": expected}
        for name, expected in BOUND.items()
        if name in LOCKED and LOCKED[name] != expected
    }

    assert misrouted == {}
