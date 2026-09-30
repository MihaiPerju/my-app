from types import SimpleNamespace

import pytest
from evals import scorers


def _ctx(output: object, input_record: dict | None = None, system: object | None = None) -> SimpleNamespace:
    return SimpleNamespace(output=output, input_record=input_record or {}, system=system, metadata={})


async def test_response_present_nonempty() -> None:
    score = await scorers.response_present.__original_eval_fn__(_ctx({"response": "hi"}))
    assert score.value == 1.0


async def test_response_present_empty() -> None:
    score = await scorers.response_present.__original_eval_fn__(_ctx({"response": "   "}))
    assert score.value == 0.0


async def test_keyword_coverage_fraction() -> None:
    ctx = _ctx({"response": "I ran a search over the source"}, {"expected_keywords": ["search", "source", "absent"]})
    score = await scorers.keyword_coverage.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(2 / 3)


async def test_keyword_coverage_no_keywords_is_full() -> None:
    score = await scorers.keyword_coverage.__original_eval_fn__(_ctx({"response": "x"}, {}))
    assert score.value == 1.0


async def test_keyword_coverage_matches_whole_words_only() -> None:
    # Substring matching would score "red" against "reduction" and silently inflate coverage.
    ctx = _ctx({"response": "a large reduction in latency"}, {"expected_keywords": ["red"]})
    score = await scorers.keyword_coverage.__original_eval_fn__(ctx)
    assert score.value == 0.0


async def test_keyword_coverage_keeps_punctuation_edged_keywords_matchable() -> None:
    # A word boundary only anchors next to a word character, so it is added per edge: anchoring
    # both edges of "c++" or "$100" would make them unmatchable.
    ctx = _ctx(
        {"response": "written in c++ for under $100 with a user_id field"},
        {"expected_keywords": ["c++", "$100", "_id"]},
    )
    score = await scorers.keyword_coverage.__original_eval_fn__(ctx)
    # "c++" and "$100" hit; "_id" must not match inside "user_id" -- `\b` treats "_" as a word char.
    assert score.value == pytest.approx(2 / 3)


async def test_matches_format_hit_and_miss() -> None:
    record = {"expected_format": r"^\{.*\}$"}
    assert (await scorers.matches_format.__original_eval_fn__(_ctx({"response": '{"a": 1}'}, record))).value == 1.0
    assert (await scorers.matches_format.__original_eval_fn__(_ctx({"response": "plain"}, record))).value == 0.0


async def test_matches_format_abstains_without_a_pattern() -> None:
    score = await scorers.matches_format.__original_eval_fn__(_ctx({"response": "anything"}, {}))
    assert score.value == 1.0


def test_parse_rating() -> None:
    assert scorers.parse_rating("8") == pytest.approx(0.8)
    assert scorers.parse_rating("rated 10 out of 10") == pytest.approx(1.0)
    assert scorers.parse_rating("no number here") == 0.0
    assert scorers.parse_rating("42") == 1.0
    assert scorers.parse_rating("") == 0.0


def test_parse_rating_is_the_shared_one_both_judges_use() -> None:
    # Re-exported from `evals.judge` rather than defined here, so the relevance judge in
    # `studio.feedback` and this quality judge cannot drift onto different scales.
    from evals.judge import parse_rating

    assert scorers.parse_rating is parse_rating


async def test_response_quality_uses_llm_judge(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Chat:
        async def complete_async(self, **kwargs: object) -> object:
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="7"))])

    class _FakeMistral:
        def __init__(self, **_: object) -> None:
            self.chat = _Chat()

    monkeypatch.setattr("mistralai.client.Mistral", _FakeMistral)
    ctx = _ctx(
        {"response": "an answer"},
        {"message": "q", "expected": "guidance"},
        SimpleNamespace(params={"judge_model": "mistral-small-latest"}),
    )
    score = await scorers.response_quality.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.7)


async def test_mean_quality_aggregates() -> None:
    ctx = SimpleNamespace(statistics={"response_quality": SimpleNamespace(avg=0.75, count=4)})
    score = await scorers.mean_quality.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.75)


async def test_mean_quality_missing_stats() -> None:
    score = await scorers.mean_quality.__original_eval_fn__(SimpleNamespace(statistics={}))
    assert score.value == 0.0
