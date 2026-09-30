"""MCP-app self-connector contributed to the orchestrator Harness.

When surfacing is enabled, this app registers its own MCP server as an ``allow_mcp_ui`` connector (see
``mistralai_capabilities.mcp_apps.server.ensure_app_connector``). Contributing that same connector as
an ``agents.connector(..., allow_mcp_ui=True)`` harness slot is what makes the deployed session
workflow surface an MCP tool's UI as a side app after a matching connector tool call: the Unified
Harness carries ``allow_mcp_ui`` from every harness connector into the workflow's connector resources
(``connector_resources`` in the compiled harness definition), so no separate ``uses_connectors`` wrap
on the promotion is needed.

Gated on ``mcp_apps_enabled`` -- with surfacing off (the default) there is no registered server for the
connector to point at, so the slot is withheld and the orchestrator answers connector-free.
This slot is the whole agent-side path: there is no separate open-app tool, the model opens an app by
calling its tool through this connector. ``mistralai_capabilities.agents.assembly`` merges
``connector`` into the single orchestrator ``Harness``. Vendored by the ``mcp-apps`` capability, which
depends on ``agents`` for the SDK and the contribution seam.
"""

from env.mcp import env as mcp_env
from mistralai.agents import agents

connector = agents.connector(mcp_env.mcp_connector_name, allow_mcp_ui=True) if mcp_env.mcp_apps_enabled else None
