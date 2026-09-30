"""Lightweight MCP App provider contract.

Modules in the app's ``mcp_apps`` package import :class:`McpApp` from here and declare one at module
scope; the host's package scan finds it. This module carries no API-host, MCP-server, workflow, or
feature-package imports, so a declaration can depend on the contract without loading the runtime.
"""

from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, Field


class McpApp(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    tool: str
    uri: str
    title: str
    description: str
    extra_frame_domains: list[str] = Field(default_factory=list)
    build_view: Callable[[str], str]
    tool_fn: Callable[..., dict[str, object]]
