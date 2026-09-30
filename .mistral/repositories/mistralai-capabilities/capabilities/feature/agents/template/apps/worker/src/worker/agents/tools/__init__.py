"""Tool contributions merged into the orchestrator Harness.

Each installed capability that contributes a model-callable tool vendors one ``<tool>.py`` module here
exposing a single module-level ``tool: agents.ToolDefinition`` (one file per tool);
``mistralai_capabilities.agents.assembly`` merges them into the single ``agents.Harness``. See
``mistralai_capabilities.agents.assembly`` for the full contract.
"""
