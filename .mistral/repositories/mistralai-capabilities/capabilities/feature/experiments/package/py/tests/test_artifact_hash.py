"""Unit tests for ``artifact_hash`` — the content-addressing helper in ``db.hashing``."""

import hashlib
import json

from mistralai_capabilities.experiments.hashing import artifact_hash


class TestArtifactHash:
    def test_deterministic(self) -> None:
        h1 = artifact_hash("prompt", {"template": "hi"})
        h2 = artifact_hash("prompt", {"template": "hi"})
        assert h1 == h2

    def test_length(self) -> None:
        h = artifact_hash("prompt", {"a": 1})
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_matches_manual_computation(self) -> None:
        typ, content = "prompt", {"template": "hello"}
        canonical = json.dumps({"type": typ, "content": content}, sort_keys=True, separators=(",", ":"))
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:64]
        assert artifact_hash(typ, content) == expected

    def test_key_order_irrelevant(self) -> None:
        h1 = artifact_hash("prompt", {"a": 1, "b": 2})
        h2 = artifact_hash("prompt", {"b": 2, "a": 1})
        assert h1 == h2

    def test_type_affects_hash(self) -> None:
        h1 = artifact_hash("prompt", {"x": 1})
        h2 = artifact_hash("config", {"x": 1})
        assert h1 != h2

    def test_content_affects_hash(self) -> None:
        h1 = artifact_hash("prompt", {"x": 1})
        h2 = artifact_hash("prompt", {"x": 2})
        assert h1 != h2

    def test_empty_content(self) -> None:
        h = artifact_hash("prompt", {})
        assert len(h) == 64

    def test_nested_content_order(self) -> None:
        h1 = artifact_hash("t", {"outer": {"z": 1, "a": 2}})
        h2 = artifact_hash("t", {"outer": {"a": 2, "z": 1}})
        assert h1 == h2
