"""The loader itself, exercised against throwaway trees rather than the shipped one.

`apps/api/tests/test_router_discovery.py` pins what the shipped tree serves. These pin what the
loader does, so they hold whatever `routers` grows into and do not go vacuous when the app
directories change.
"""

import sys
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi.routing import (
    DuplicateRouteError,
    NoRoutersDiscoveredError,
    UndeclaredAccessRuleError,
    create_api_router,
)

_ANONYMOUS = "from fastapi import params\n\ndependencies: tuple[params.Depends, ...] = ()\n"


def _app(router: APIRouter) -> FastAPI:
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    app.include_router(router)
    return app


def _tree(root: Path, name: str, **files: str) -> Path:
    package = root / name
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text("")
    for stem, source in files.items():
        (package / f"{stem}.py").write_text(source)
    return package


def _module(path: str) -> str:
    return (
        "from fastapi import APIRouter\n\n"
        "router = APIRouter()\n\n\n"
        f'@router.get("{path}")\n'
        "def endpoint() -> str:\n"
        '    return "ok"\n'
    )


def _forget(prefix: str) -> None:
    for name in [n for n in sys.modules if n == prefix or n.startswith(f"{prefix}.")]:
        del sys.modules[name]


def test_a_package_that_serves_nothing_needs_no_access_rule(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-serving package may sit in the walked tree without declaring a policy it cannot apply.

    This is the complement of `test_a_subtree_that_declares_no_rule_refuses_to_mount`, and it is
    easy to break while fixing that one: tightening the loader to "every package must declare"
    would pass that test and fail this one. The silent package here declares nothing and is
    reached while `dependencies` is still `None`, so it is the real case.
    """
    root = _tree(tmp_path, "quiet_pkg")
    _tree(root, "helpers", thing="VALUE = 1")
    group = _tree(root, "group", route=_module(""))
    (group / "__init__.py").write_text(_ANONYMOUS)
    monkeypatch.syspath_prepend(str(tmp_path))

    assert set(_app(create_api_router("quiet_pkg")).openapi()["paths"]) == {"/group"}
    _forget("quiet_pkg")


def test_a_private_module_is_never_mounted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _tree(tmp_path, "private_pkg", route=_module("/public"), _helper=_module("/private"))
    (root / "__init__.py").write_text(_ANONYMOUS)
    monkeypatch.syspath_prepend(str(tmp_path))

    assert set(_app(create_api_router("private_pkg")).openapi()["paths"]) == {"/public"}
    _forget("private_pkg")


def test_the_rule_cascades_into_nested_packages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A nested package that declares nothing inherits its parent's rule."""
    _tree(tmp_path, "cascade_pkg")
    guarded = _tree(tmp_path / "cascade_pkg", "guarded", leaf=_module("/leaf"))
    (guarded / "__init__.py").write_text(
        "from fastapi import Depends, params\n\n\n"
        "async def _gate() -> None:\n"
        "    raise RuntimeError('the rule ran')\n\n\n"
        "dependencies: tuple[params.Depends, ...] = (Depends(_gate),)\n"
    )
    _tree(guarded, "deeper", inner=_module("/inner"))
    monkeypatch.syspath_prepend(str(tmp_path))

    client = TestClient(_app(create_api_router("cascade_pkg")), raise_server_exceptions=False)

    assert client.get("/guarded/leaf/leaf").status_code == 500
    assert client.get("/guarded/deeper/inner/inner").status_code == 500, (
        "a package that declares nothing must inherit its ancestor's rule, not escape it"
    )
    _forget("cascade_pkg")


def test_a_subtree_that_declares_no_rule_refuses_to_mount(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Anonymity is never inferred, because it is the dangerous half of the answer.

    A subtree that says nothing looks exactly like one meant to be public, so the loader cannot
    tell them apart and must not guess. This turns a forgotten folder into an import failure, not
    an open endpoint.
    """
    _tree(tmp_path, "silent_pkg")
    _tree(tmp_path / "silent_pkg", "group", leaf=_module("/leaf"))
    monkeypatch.syspath_prepend(str(tmp_path))

    with pytest.raises(UndeclaredAccessRuleError, match="declares `dependencies`"):
        create_api_router("silent_pkg")
    _forget("silent_pkg")


def test_route_py_is_the_directory_index_and_other_files_are_segments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = _tree(tmp_path, "conv_pkg")
    (package / "__init__.py").write_text(_ANONYMOUS)
    _tree(package, "users", route=_module(""), profile=_module(""))
    monkeypatch.syspath_prepend(str(tmp_path))

    assert set(_app(create_api_router("conv_pkg")).openapi()["paths"]) == {"/users", "/users/profile"}
    _forget("conv_pkg")


def test_a_bracketed_name_becomes_a_path_parameter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = _tree(tmp_path, "param_pkg")
    (package / "__init__.py").write_text(_ANONYMOUS)
    _tree(package, "users", **{"[user_id]": _module("")})
    monkeypatch.syspath_prepend(str(tmp_path))

    assert set(_app(create_api_router("param_pkg")).openapi()["paths"]) == {"/users/{user_id}"}
    _forget("param_pkg")


def test_two_modules_claiming_one_url_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two packages can rename onto the same segment; serving one and hiding the other silently
    would make the shadowed file look broken rather than misplaced.

    A file and a directory of the same name cannot collide, because Python will not import both,
    so renaming via `segment` is how a duplicate reaches the loader.
    """
    package = _tree(tmp_path, "dupe_pkg")
    (package / "__init__.py").write_text(_ANONYMOUS)
    for name in ("first", "second"):
        child = _tree(package, name, route=_module(""))
        (child / "__init__.py").write_text('segment = "same"\n')
    monkeypatch.syspath_prepend(str(tmp_path))

    with pytest.raises(DuplicateRouteError, match="claimed by both"):
        create_api_router("dupe_pkg")
    _forget("dupe_pkg")


def test_a_module_exposing_no_router_is_skipped_not_fatal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = _tree(tmp_path, "mixed_pkg", helper="VALUE = 1", real=_module(""))
    (package / "__init__.py").write_text(_ANONYMOUS)
    monkeypatch.syspath_prepend(str(tmp_path))

    assert set(_app(create_api_router("mixed_pkg")).openapi()["paths"]) == {"/real"}
    _forget("mixed_pkg")


def test_discovering_nothing_is_an_error_not_an_empty_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A package yielding no routes is indistinguishable from a healthy app serving 404s.

    The failure this guards against is a packaging change making the modules invisible: silent in
    dev, an entire API missing in production.
    """
    _tree(tmp_path, "empty_pkg", helper="VALUE = 1")
    monkeypatch.syspath_prepend(str(tmp_path))

    with pytest.raises(NoRoutersDiscoveredError, match="no route module"):
        create_api_router("empty_pkg")
    _forget("empty_pkg")


def test_a_broken_route_module_raises_rather_than_vanishing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo must not silently unmount routes and leave the app answering 404."""
    package = _tree(tmp_path, "broken_pkg", bad="import a_module_that_does_not_exist")
    (package / "__init__.py").write_text(_ANONYMOUS)
    monkeypatch.syspath_prepend(str(tmp_path))

    with pytest.raises(ModuleNotFoundError):
        create_api_router("broken_pkg")
    _forget("broken_pkg")


def test_pointing_at_a_module_instead_of_a_package_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _tree(tmp_path, "leaf_pkg", helper="VALUE = 1")
    monkeypatch.syspath_prepend(str(tmp_path))

    with pytest.raises(NoRoutersDiscoveredError, match="module, not a package"):
        create_api_router("leaf_pkg.helper")
    _forget("leaf_pkg")
