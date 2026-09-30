"""Shared pytest fixtures/markers for the mistralai-capabilities Python spine."""

import os
from pathlib import Path

import env
import pytest

_CAPABILITIES = Path(__file__).resolve().parents[5]
env.__path__.extend(
    [
        str(_CAPABILITIES / "backend/workflows/template/packages/py/env/src/env"),
        str(_CAPABILITIES / "feature/agents/template/packages/py/env/src/env"),
        str(_CAPABILITIES / "feature/evals/template/packages/py/env/src/env"),
        str(_CAPABILITIES / "feature/observability/template/packages/py/env/src/env"),
    ]
)

HAS_MISTRAL_KEY = bool(os.getenv("MISTRAL_API_KEY"))
requires_mistral_key = pytest.mark.skipif(not HAS_MISTRAL_KEY, reason="MISTRAL_API_KEY not set")
