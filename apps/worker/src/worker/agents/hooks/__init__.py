"""Hook contributions merged into the orchestrator Harness.

Each installed capability that contributes a lifecycle hook vendors one ``<hook>.py`` module here
exposing a single module-level ``hook: agents.Hook`` (stateless only -- the worker rejects stateful
``agents.State`` hooks; one file per hook); ``mistralai_capabilities.agents.assembly`` merges them into the single
``agents.Harness``. See ``mistralai_capabilities.agents.assembly`` for the full contract.
"""
