"""Connector contributions merged into the orchestrator Harness.

Each installed capability that contributes an external-service connector vendors one ``<key>.py``
module here exposing a single module-level ``connector: agents.Connector`` (an
``agents.connector("<key>")`` slot -- one file per connector); ``mistralai_capabilities.agents.assembly`` merges them
into the single ``agents.Harness``. A module may set ``connector = None`` to opt out (e.g. a gated
connector). See ``mistralai_capabilities.agents.assembly`` for the full contract.
"""
