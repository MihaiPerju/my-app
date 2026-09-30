"""Content-addressed hashing helpers (stdlib-only, no DB dependencies)."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def artifact_hash(type: str, content: dict[str, Any]) -> str:
    """Content-address for an artifact: order-independent SHA-256, 64 hex chars."""
    canonical = json.dumps({"type": type, "content": content}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:64]


def experiment_definition_hash(config: dict[str, Any], artifact_names: list[str]) -> str:
    """Content-address for an experiment definition: config + sorted artifact names."""
    canonical = json.dumps(
        {"config": config, "artifact_names": sorted(artifact_names)},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:64]
