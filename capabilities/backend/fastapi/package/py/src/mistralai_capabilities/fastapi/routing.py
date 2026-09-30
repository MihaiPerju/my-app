"""File-based routing: the directory tree under a package is the URL tree.
``foo/``                    contributes ``foo``, unless it declares ``segment``
``segment = ""``            contributes nothing
``route.py``                the directory index; contributes nothing
``bar.py``                  contributes ``bar``
``[thing]``                 contributes ``{thing}`` in a file or directory name
no module-level ``router``  contributes nothing
"""

import importlib
import pkgutil
import re
from collections.abc import Iterator
from dataclasses import dataclass

from fastapi import APIRouter, FastAPI
from fastapi.params import Depends
from fastapi.routing import APIRoute, iter_route_contexts

_PARAM = re.compile(r"\[(.*?)\]")
_INDEX = "route"


class UndeclaredAccessRuleError(RuntimeError):
    """Raised when a route would be served from a subtree that declares no access rule."""


class DuplicateRouteError(RuntimeError):
    """Raised when two modules claim the same URL."""


class NoRoutersDiscoveredError(RuntimeError):
    """Raised when a package that should expose routers exposes none."""


def _url_segment(name: str) -> str:
    return _PARAM.sub(lambda m: "{" + m.group(1) + "}", name)


def _sort_key(path: str) -> tuple[tuple[int, str], ...]:
    """Static segments before parameterised ones, at every depth.

    FastAPI matches in registration order, so ``/users/me`` has to be registered before
    ``/users/{id}`` or the parameterised route swallows it.
    """
    return tuple((1 if "{" in part else 0, part) for part in path.split("/"))


@dataclass(frozen=True)
class _Mount:
    path: str
    router: APIRouter
    dependencies: tuple[Depends, ...]
    source: str


def _collect(
    package_name: str,
    segments: tuple[str, ...],
    dependencies: tuple[Depends, ...] | None,
) -> Iterator[_Mount]:
    """Walk one package, yielding a mount per route module under it.

    ``dependencies`` is ``None`` until a package on the way down declares a rule. This gives the
    fail-closed guarantee: a module reached while it is still ``None`` has no declaring ancestor,
    which is an error and not an anonymous route.
    """
    package = importlib.import_module(package_name)
    if not hasattr(package, "__path__"):
        raise NoRoutersDiscoveredError(f"{package_name!r} is a module, not a package")

    if hasattr(package, "dependencies"):
        dependencies = (*(dependencies or ()), *package.dependencies)

    for info in sorted(pkgutil.iter_modules(package.__path__, f"{package_name}."), key=lambda m: m.name):
        name = info.name.rpartition(".")[2]
        # `_`-prefixed modules are private helpers, never routes: the rule hook discovery follows.
        if name.startswith("_"):
            continue

        if info.ispkg:
            segment = _url_segment(getattr(importlib.import_module(info.name), "segment", name))
            yield from _collect(info.name, (*segments, segment) if segment else segments, dependencies)
            continue

        router = getattr(importlib.import_module(info.name), "router", None)
        if not isinstance(router, APIRouter):
            continue
        if dependencies is None:
            raise UndeclaredAccessRuleError(
                f"{info.name!r} serves routes but no package above it declares `dependencies`. "
                "Add `dependencies: tuple[params.Depends, ...]` to a parent `__init__` — `()` if the "
                "subtree is meant to be anonymous. It is never inferred, because the default would "
                "be public."
            )

        own = segments if name == _INDEX else (*segments, _url_segment(name))
        yield _Mount("/" + "/".join(own) if own else "", router, dependencies, info.name)


def _mounts(package_name: str) -> list[_Mount]:
    found = list(_collect(package_name, (), None))
    if not found:
        raise NoRoutersDiscoveredError(f"{package_name!r} exposed no route module")

    seen: dict[str, str] = {}
    for mount in found:
        if mount.path in seen:
            raise DuplicateRouteError(f"{mount.path or '/'!r} is claimed by both {seen[mount.path]} and {mount.source}")
        seen[mount.path] = mount.source
    return found


def create_api_router(package_name: str, *, prefix: str = "") -> APIRouter:
    """Every route module under ``package_name``, mounted where the tree says it belongs.

    ``prefix`` is where the caller hangs the tree. Raises if two modules claim one URL, if a
    module serves a subtree with no access rule, or if nothing was found. The last case matters
    because a packaging change that hides every module looks like a healthy app with no routes.
    """
    api = APIRouter(prefix=prefix)
    for mount in sorted(_mounts(package_name), key=lambda m: _sort_key(m.path)):
        api.include_router(mount.router, prefix=mount.path, dependencies=list(mount.dependencies))
    return api


def anonymous_paths(package_name: str) -> frozenset[str]:
    """Every path served with no access rule attached.

    Reads the rules the loader applied, so a group that gains a dependency leaves this set.
    Mounted on a throwaway app because ``include_router`` resolves against an app. The app has
    no OpenAPI, docs, or redoc url, so every path here came from the tree.
    """
    probe = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    for mount in _mounts(package_name):
        if not mount.dependencies:
            probe.include_router(mount.router, prefix=mount.path)

    return frozenset(
        context.path
        for context in iter_route_contexts(probe.routes)
        if isinstance(context.original_route, APIRoute) and context.path is not None
    )
