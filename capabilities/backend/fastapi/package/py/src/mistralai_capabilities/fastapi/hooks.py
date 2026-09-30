"""Deterministic app-local extension hooks for the generated FastAPI host."""

import asyncio
import importlib
import importlib.util
import logging
import pkgutil
from collections.abc import Awaitable, Callable, Mapping
from types import MappingProxyType, ModuleType

from fastapi import FastAPI

ConfigureHook = Callable[[FastAPI], None]
AsyncHook = Callable[[FastAPI], Awaitable[None]]
Probe = Callable[[], Awaitable[bool]]
MetadataProvider = Callable[[], str | None]

logger = logging.getLogger(__name__)


class FastAPIHookDiscoveryError(RuntimeError):
    """A hook catalog or lifecycle transition could not be used safely."""


class FastAPIHooks:
    def __init__(
        self,
        *,
        configure_hooks: tuple[tuple[str, ConfigureHook], ...] = (),
        startup_hooks: tuple[tuple[str, AsyncHook], ...] = (),
        shutdown_hooks: tuple[tuple[str, AsyncHook], ...] = (),
        report_checks: tuple[tuple[str, Probe], ...] = (),
        readiness_checks: tuple[tuple[str, Probe], ...] = (),
        metadata_values: Mapping[str, str | None] | None = None,
    ) -> None:
        self.configure_hooks = _catalog("configure", configure_hooks)
        self.startup_hooks = _catalog("startup", startup_hooks)
        self.shutdown_hooks = _catalog("shutdown", shutdown_hooks)
        self.report_checks = _catalog("report", report_checks)
        self.readiness_checks = _catalog("readiness", readiness_checks)
        metadata = dict(metadata_values or {})
        self.metadata_values: Mapping[str, str | None] = MappingProxyType(
            dict(sorted(metadata.items()))
        )
        self._configured_app: FastAPI | None = None
        self._startup_attempted = False
        self._shutdown_complete = False

    @classmethod
    def discover(cls, root: str = "api") -> "FastAPIHooks":
        metadata_providers = _discover(f"{root}.health.metadata", "metadata")
        return cls(
            configure_hooks=_discover(f"{root}.configure", "configure"),
            startup_hooks=_discover(f"{root}.lifespan.startup", "startup"),
            shutdown_hooks=_discover(f"{root}.lifespan.shutdown", "shutdown"),
            report_checks=_discover(f"{root}.health.report", "check"),
            readiness_checks=_discover(f"{root}.health.ready", "check"),
            metadata_values={name: provider() for name, provider in metadata_providers},
        )

    @classmethod
    def empty(cls) -> "FastAPIHooks":
        return cls()

    @classmethod
    def compose(cls, *hook_sets: "FastAPIHooks") -> "FastAPIHooks":
        metadata: dict[str, str | None] = {}
        for hooks in hook_sets:
            for key, value in hooks.metadata_values.items():
                if key in metadata:
                    raise FastAPIHookDiscoveryError(f"duplicate metadata hook {key!r}")
                metadata[key] = value
        return cls(
            configure_hooks=tuple(
                item for hooks in hook_sets for item in hooks.configure_hooks
            ),
            startup_hooks=tuple(
                item for hooks in hook_sets for item in hooks.startup_hooks
            ),
            shutdown_hooks=tuple(
                item for hooks in hook_sets for item in hooks.shutdown_hooks
            ),
            report_checks=tuple(
                item for hooks in hook_sets for item in hooks.report_checks
            ),
            readiness_checks=tuple(
                item for hooks in hook_sets for item in hooks.readiness_checks
            ),
            metadata_values=metadata,
        )

    def configure(self, app: FastAPI) -> None:
        if self._configured_app is not None:
            detail = (
                "the same app" if self._configured_app is app else "a different app"
            )
            raise FastAPIHookDiscoveryError(f"configure hooks already ran for {detail}")
        self._configured_app = app
        for _, hook in self.configure_hooks:
            hook(app)

    async def startup(self, app: FastAPI) -> None:
        self._require_configured_app(app)
        if self._startup_attempted:
            raise FastAPIHookDiscoveryError("startup hooks were already attempted")
        self._startup_attempted = True
        for _, hook in self.startup_hooks:
            await hook(app)

    async def shutdown(self, app: FastAPI) -> None:
        self._require_configured_app(app)
        if not self._startup_attempted:
            raise FastAPIHookDiscoveryError("shutdown requires a startup attempt")
        if self._shutdown_complete:
            raise FastAPIHookDiscoveryError("shutdown hooks already ran")
        self._shutdown_complete = True
        failures: list[Exception] = []
        for _, hook in reversed(self.shutdown_hooks):
            try:
                await hook(app)
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("FastAPI shutdown hook failures", failures)

    async def report(self) -> dict[str, bool]:
        return await _run_probes(self.report_checks)

    async def ready(self) -> dict[str, bool]:
        return await _run_probes(self.readiness_checks)

    def _require_configured_app(self, app: FastAPI) -> None:
        if self._configured_app is None:
            raise FastAPIHookDiscoveryError("configure hooks have not run")
        if self._configured_app is not app:
            raise FastAPIHookDiscoveryError("hooks cannot run for a different app")


def _catalog(name: str, entries: tuple[tuple[str, Callable[..., object]], ...]):
    ordered = tuple(sorted(entries, key=lambda item: item[0]))
    seen: set[str] = set()
    for key, _ in ordered:
        if key in seen:
            raise FastAPIHookDiscoveryError(f"duplicate {name} hook {key!r}")
        seen.add(key)
    return ordered


def _discover(package: str, declaration: str):
    try:
        spec = importlib.util.find_spec(package)
    except ModuleNotFoundError as error:
        missing = error.name or ""
        if package == missing or package.startswith(f"{missing}."):
            spec = None
        else:
            raise FastAPIHookDiscoveryError(
                f"FastAPI hook package {package!r} could not be inspected: {error}"
            ) from error
    except Exception as error:
        raise FastAPIHookDiscoveryError(
            f"FastAPI hook package {package!r} could not be inspected: {error}"
        ) from error
    if spec is None:
        logger.debug(
            "no FastAPI hook package %r installed; using an empty catalog", package
        )
        return ()
    if spec.submodule_search_locations is None:
        raise FastAPIHookDiscoveryError(
            f"FastAPI hook package {package!r} is a module, not a package"
        )

    found = pkgutil.iter_modules(spec.submodule_search_locations, prefix=f"{package}.")
    hooks = []
    seen: set[str] = set()
    for _, module_name, _ in sorted(found, key=lambda entry: entry[1]):
        key = module_name.rpartition(".")[2]
        if key.startswith("_"):
            continue
        if key in seen:
            raise FastAPIHookDiscoveryError(f"duplicate {package} hook {key!r}")
        seen.add(key)
        module = _import_module(module_name)
        if not hasattr(module, declaration):
            raise FastAPIHookDiscoveryError(
                f"FastAPI hook module {module_name!r} does not declare {declaration!r}"
            )
        hook = getattr(module, declaration)
        if not callable(hook):
            raise FastAPIHookDiscoveryError(
                f"FastAPI hook declaration {module_name}.{declaration} is {type(hook).__name__}, not callable"
            )
        hooks.append((key, hook))
    return tuple(hooks)


def _import_module(module_name: str) -> ModuleType:
    try:
        return importlib.import_module(module_name)
    except Exception as error:
        raise FastAPIHookDiscoveryError(
            f"FastAPI hook module {module_name!r} could not be imported: {error}"
        ) from error


async def _run_probes(probes: tuple[tuple[str, Probe], ...]) -> dict[str, bool]:
    async def run(name: str, probe: Probe) -> bool:
        try:
            return await probe()
        except Exception:
            logger.exception("FastAPI health probe %r failed", name)
            return False

    results = await asyncio.gather(*(run(name, probe) for name, probe in probes))
    return {name: result for (name, _), result in zip(probes, results, strict=True)}
