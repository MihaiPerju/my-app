import pytest
from cli.commands import guardrail


def test_guardrail_step_is_skipped_when_similarity_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    seeded: list[str] = []
    monkeypatch.setattr(guardrail.guardrail_env, "guardrail_enabled", True)
    monkeypatch.setattr(guardrail.guardrail_env, "guardrail_similarity_enabled", False)
    monkeypatch.setattr(guardrail, "seed_guardrail_corpus", lambda: seeded.append("seeded"))

    guardrail.main()

    assert seeded == []
