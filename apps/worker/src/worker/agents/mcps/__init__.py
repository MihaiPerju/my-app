"""Remote MCP-server contributions merged into the orchestrator Harness.

Each installed capability that contributes a remote HTTP MCP server vendors one ``<name>.py`` module
here exposing a single module-level ``mcp`` (keyed by the module/file name -- one file per server);
``mistralai_capabilities.agents.assembly`` merges them into the single ``agents.Harness``. See
``mistralai_capabilities.agents.assembly`` for the full contract.
"""
