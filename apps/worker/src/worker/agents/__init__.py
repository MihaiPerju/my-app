"""The file-defined orchestrator project the worker promotes to a Unified Harness workflow.

`agent.py` is the entrypoint (`[tool.mistralai.agents].entrypoint = "worker.agents.agent:agent"`); it
builds the single `agents.Agent` whose `Harness` is assembled from the installed capabilities'
contribution modules. There are no subagents: the Unified Harness backend does not support them.
"""
