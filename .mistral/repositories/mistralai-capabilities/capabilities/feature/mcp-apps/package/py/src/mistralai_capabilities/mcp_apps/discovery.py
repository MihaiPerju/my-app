"""Discover the MCP Apps declared by the app's ``mcp_apps`` package.

Like workflows: capabilities drop one module per app into an app-local workspace member, and the
host scans it at startup. A module-level :class:`McpApp` is the declaration; nothing is registered.
"""

import importlib
import importlib.util
import logging
import pkgutil
from types import ModuleType

from mistralai_capabilities.mcp_apps.contract import McpApp

_MCP_APP_PACKAGE = "api.mcp_apps"
# The declaring name. A naming contract, not a type scan: an `McpApp` bound to any other name —
# imported from a sibling, built as a template, held by a helper — is not a declaration, and
# type-sniffing every attribute would claim its tool and abort startup.
_DECLARATION = "app"

logger = logging.getLogger(__name__)


class McpAppDiscoveryError(RuntimeError):
    """An MCP App declaration could not be used safely."""


def discover_mcp_apps(package: str = _MCP_APP_PACKAGE) -> list[McpApp]:
    """Load every MCP App declared by a child module of ``package``, in a deterministic order.

    One child, one app: ``account.py``, or ``account/`` declaring in its ``__init__.py`` when the
    app ships a view template beside it. One level deep is enough. A module declares by binding an
    :class:`McpApp` to ``app``; anything else it holds is ignored, and no ``app`` is not an error. An
    uninstalled ``package`` is an empty catalog, the right answer for a composition with no MCP Apps
    and what lets this module be tested outside a generated app.
    """
    try:
        spec = importlib.util.find_spec(package)
    except (ImportError, ValueError):
        spec = None
    if spec is None:
        logger.debug("no MCP App package %r installed; serving an empty catalog", package)
        return []
    if spec.submodule_search_locations is None:
        raise McpAppDiscoveryError(f"MCP App package {package!r} is a module, not a package")

    apps: list[McpApp] = []
    tools: dict[str, str] = {}
    uris: dict[str, str] = {}
    # By name, not the raw tuple: a namespace package has several search-path entries, so the
    # finders differ and tuple comparison would reach an unorderable `<`.
    found = pkgutil.iter_modules(spec.submodule_search_locations, prefix=f"{package}.")
    for _, module_name, _ in sorted(found, key=lambda entry: entry[1]):
        module = _import_declaring_module(module_name)
        app = getattr(module, _DECLARATION, None)
        if app is None:
            continue
        if not isinstance(app, McpApp):
            raise McpAppDiscoveryError(f"{module_name}.{_DECLARATION} is {type(app).__name__}, not an McpApp")
        _claim(kind="MCP tool", value=app.tool, declaration=module_name, claimed=tools)
        _claim(kind="MCP resource URI", value=app.uri, declaration=module_name, claimed=uris)
        apps.append(app)
    return apps


def _import_declaring_module(module_name: str) -> ModuleType:
    """Import ``module_name``, raising where the workflows scan would log and move on.

    The host mounts what it discovers, so a skipped module is an MCP surface that vanishes
    silently. Failing the boot is the smaller loss.
    """
    try:
        return importlib.import_module(module_name)
    except Exception as error:
        raise McpAppDiscoveryError(f"MCP App module {module_name!r} could not be imported: {error}") from error


def _claim(*, kind: str, value: str, declaration: str, claimed: dict[str, str]) -> None:
    """Record ``declaration`` as the owner of ``value``, or refuse a second claimant."""
    if previous := claimed.get(value):
        raise McpAppDiscoveryError(f"duplicate {kind} {value!r}: declarations {previous!r} and {declaration!r}")
    claimed[value] = declaration
