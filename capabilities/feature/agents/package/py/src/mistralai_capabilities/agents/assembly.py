"""Assemble the orchestrator `Harness` from installed capability contributions.

Subagents are unsupported on the Unified Harness backend, so the orchestrator is a single agent whose
`Harness` absorbs every installed capability's tools, connectors, hooks, and MCP servers. There is no
file-defined subagent tree for the SDK to discover, so the harness is built by hand from one
contribution package per kind. Each contribution is ONE module exposing a single module-level object
-- one file per tool, connector, hook, or MCP server::

    tools/<tool>.py       tool: agents.ToolDefinition    # model-callable tool (model_access="direct")
    connectors/<key>.py   connector: agents.Connector    # an agents.connector("<key>") slot
    hooks/<hook>.py       hook: agents.Hook              # a stateless hook (stateful ones are worker-rejected)
    mcps/<name>.py        mcp: agents.RemoteMCP          # a remote HTTP MCP server, keyed by the module name

A module may set its slot to ``None`` to opt out (e.g. a connector gated behind a setting). Nothing
here names a capability: the app passes its four kind packages in, and a module is present only when
its capability is installed. A module missing its kind's slot, exporting the wrong element type, or
colliding on a tool/connector/mcp name fails assembly loudly rather than vanishing from the Harness.
"""

from __future__ import annotations

import importlib
import pkgutil
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from types import ModuleType
from typing import Any

from mistralai.agents import agents


@dataclass(frozen=True)
class _Kind:
    slot: str
    type: type
    # How the error message names the expected type (the SDK classes behind the aliases differ).
    label: str
    # The name a contribution must be unique by, from `(module_name, item)`.
    key: Callable[[str, Any], str]


_TOOL = _Kind("tool", agents.ToolDefinition, "an agents.tool definition", lambda _module, tool: tool.name)
_CONNECTOR = _Kind(
    "connector", agents.Connector, "an agents.connector() slot", lambda _module, slot: slot.connector_name
)
# Hooks carry no name; the module name is unique by construction, so any number may compose.
_HOOK = _Kind("hook", agents.Hook, "an agents.Hook", lambda module, _hook: module)
_MCP = _Kind("mcp", agents.RemoteMCP, "an agents.RemoteMCP", lambda module, _mcp: module.rsplit(".", 1)[-1])


def _contributions(package: ModuleType, kind: _Kind) -> Iterator[tuple[str, Any]]:
    """Yield `(key, item)` for each module in `package`, validated against `kind`.

    Modules are walked in name order; ``_``-prefixed modules are private helpers and skipped. A module
    whose slot is ``None`` has opted out and is skipped.
    """
    seen: set[str] = set()
    for module_info in sorted(pkgutil.iter_modules(package.__path__), key=lambda info: info.name):
        if module_info.name.startswith("_"):
            continue
        module_name = f"{package.__name__}.{module_info.name}"
        module = importlib.import_module(module_name)
        if not hasattr(module, kind.slot):
            raise TypeError(
                f"{module_name} is a {kind.slot} contribution but does not expose `{kind.slot}`; each "
                f"contribution module declares one `{kind.slot}` (or `{kind.slot} = None` to opt out)."
            )
        item = getattr(module, kind.slot)
        if item is None:
            continue
        if not isinstance(item, kind.type):
            raise TypeError(f"{module_name}: `{kind.slot}` must be {kind.label}, got {type(item).__name__}")
        key = kind.key(module_name, item)
        if key in seen:
            raise ValueError(f"{module_name}: duplicate {kind.slot} {key!r}")
        seen.add(key)
        yield key, item


def assemble_harness(
    *, tools: ModuleType, connectors: ModuleType, hooks: ModuleType, mcps: ModuleType
) -> agents.Harness:
    """Merge every contribution module in the four kind packages into one `agents.Harness`."""
    return agents.Harness(
        tools=[tool for _, tool in _contributions(tools, _TOOL)],
        connectors=[connector for _, connector in _contributions(connectors, _CONNECTOR)],
        hooks=[hook for _, hook in _contributions(hooks, _HOOK)],
        mcps=dict(_contributions(mcps, _MCP)),
    )
