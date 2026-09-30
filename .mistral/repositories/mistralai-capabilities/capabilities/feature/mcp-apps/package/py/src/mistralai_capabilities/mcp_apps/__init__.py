"""Declarative MCP Apps: the declaration contract, the discovery scan, the surfacing runtime.

Empty on purpose. `contract` must stay cheap to import (every module in the app's `mcp_apps`
catalog imports it) while `server` next door pulls FastMCP. Importing a submodule runs only this
file, never a sibling, so re-exporting anything here would put it in front of all three.
`tests/test_mcp_apps.py` fails if that changes.
"""
