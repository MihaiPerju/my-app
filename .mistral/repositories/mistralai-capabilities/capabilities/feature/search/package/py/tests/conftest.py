"""Shared pytest fixtures/markers for the mistralai-capabilities Python spine."""

import os

import pytest

HAS_MISTRAL_KEY = bool(os.getenv("MISTRAL_API_KEY"))
requires_mistral_key = pytest.mark.skipif(not HAS_MISTRAL_KEY, reason="MISTRAL_API_KEY not set")
