"""The app's MCP Apps must resolve: a module that cannot be imported, or a tool or `ui://` claimed
twice, fails here rather than at API boot. An empty catalog is a pass.

Not `test_discovery.py`: no `tests/` directory here carries an `__init__.py`, so pytest imports by
bare basename and the worker's file of that name would collide.
"""

from mistralai_capabilities.mcp_apps.discovery import discover_mcp_apps


def test_discover_resolves_installed_mcp_app_modules() -> None:
    discover_mcp_apps("api.mcp_apps")
