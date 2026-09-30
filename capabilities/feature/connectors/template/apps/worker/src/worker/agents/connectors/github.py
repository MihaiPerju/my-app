"""GitHub connector slot for the orchestrator Harness.

``agents.connector`` resolves credentials and drives any OAuth flow through the Mistral Connectors
platform; the key must already be configured for the workspace. ``mistralai_capabilities.agents.assembly`` merges the
module-level ``connector`` into the single ``agents.Harness`` (one file per connector).
"""

from mistralai.agents import agents

connector = agents.connector("github")
