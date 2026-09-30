"""Seed-path helpers (stdlib-only, no DB dependencies)."""

from __future__ import annotations

from pathlib import PurePosixPath


def seed_name_from_path(path: str, *, category: str | None = None) -> str:
    """Map a seed-folder path to a name: colon-joined parts, no ``seed/[<category>/]`` and no extension."""
    parts = PurePosixPath(path.strip()).parts
    if not parts:
        raise ValueError("empty seed path")
    if parts[0] in (".", ""):
        parts = parts[1:]
    if parts and parts[0] == "seed":
        parts = parts[1:]
    if category is not None and parts and parts[0] == category:
        parts = parts[1:]
    if not parts:
        raise ValueError(f"seed path names no artifact: {path!r}")
    stem_parts = [*parts[:-1], PurePosixPath(parts[-1]).stem]
    return ":".join(stem_parts)
