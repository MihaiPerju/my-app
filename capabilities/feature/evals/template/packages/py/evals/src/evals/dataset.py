"""Seed evaluation cases for the agent E2E harness, loaded from JSON data files.

Each record is one turn sent to the ``agents`` orchestrator: ``message`` is the input,
``expected_keywords`` drive the routing scorer, and ``expected`` guides the LLM judge.
``SEARCH_RETRIEVAL_DATASET`` is the retrieval gold set. Cases are JSON arrays in ``data/``.
"""

import json
from importlib.resources import files
from typing import Any

_DATA_DIR = files(__package__) / "data"


def _load_json(name: str) -> list[dict[str, Any]]:
    return json.loads(_DATA_DIR.joinpath(name).read_text())


DEFAULT_DATASET: list[dict[str, Any]] = _load_json("agent_eval.json")
SEARCH_RETRIEVAL_DATASET: list[dict[str, Any]] = _load_json("search_retrieval_eval.json")
