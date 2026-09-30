import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from evals import scorers
from evals.search import relevance
from evals.search.relevance import LabelResultResponse, LLMResponseError, ResultPage

_LABEL_JSON = json.dumps(
    {
        "language": "en",
        "description": "A page about capital requirements.",
        "description_translated": None,
        "reasoning": "Directly answers the query.",
        "reasoning_translated": None,
        "tags": {
            "broken": False,
            "vital": True,
            "volatile": False,
            "stale": False,
            "spam": False,
            "harmful": False,
        },
        "score": 4,
        "document_date": None,
    }
)


class _Parsed:
    def __init__(self, content: str) -> None:
        self._content = content

    def model_dump(self, mode: str = "json") -> dict:
        return {
            "choices": [{"message": {"content": self._content}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7},
        }


class _Chat:
    def __init__(self, replies: list[str]) -> None:
        self.replies = replies
        self.calls: list[dict] = []

    async def parse_async(self, **kwargs: object) -> _Parsed:
        assert kwargs.get("response_format") is LabelResultResponse
        self.calls.append(kwargs)
        content = self.replies[min(len(self.calls), len(self.replies)) - 1]
        # Like the SDK's `convert_to_parsed_chat_completion_response`: it `json.loads` the reply and
        # validates it against `response_format` itself, so a malformed answer raises from this call.
        LabelResultResponse.model_validate(json.loads(content))
        return _Parsed(content)


def _install(monkeypatch: pytest.MonkeyPatch, replies: list[str]) -> _Chat:
    chat = _Chat(replies)

    class _FakeMistral:
        def __init__(self, **_: object) -> None:
            self.chat = chat

    monkeypatch.setattr("evals.search.relevance.Mistral", _FakeMistral)
    return chat


@pytest.fixture(autouse=True)
def _fake_sdk(monkeypatch: pytest.MonkeyPatch) -> _Chat:
    return _install(monkeypatch, [_LABEL_JSON])


def test_system_prompt_stamps_date_and_embeds_output_schema() -> None:
    prompt = relevance.system_prompt(datetime(2026, 1, 2, 3, 4, tzinfo=UTC))
    assert "**Current date and time (UTC):** 2026-01-02 03:04" in prompt
    assert '"title": "LabelResultResponse"' in prompt
    assert "{today_date}" not in prompt
    assert "{label_result_output_schema}" not in prompt


def test_strip_markdown_code_blocks() -> None:
    assert relevance._strip_markdown_code_blocks('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert relevance._strip_markdown_code_blocks('```\n{"a": 1}```') == '{"a": 1}'


def test_response_text_extracts_content() -> None:
    assert relevance._response_text({"choices": [{"message": {"content": "hello"}}]}) == "hello"
    assert relevance._response_text({"choices": []}) == ""


async def test_judge_relevance_scores_page() -> None:
    response = await relevance.judge_relevance(
        "net capital requirement",
        ResultPage(url="chunk://x", title=None, text="the net capital requirement was forty two billion dollars"),
    )
    assert response.score == 4
    assert response.tags.vital is True


async def test_judge_relevance_sends_system_and_user_prompts(_fake_sdk: _Chat) -> None:
    await relevance.judge_relevance("q", ResultPage(url="chunk://x"), model_id="mistral-medium-latest")
    call = _fake_sdk.calls[0]
    assert call["model"] == "mistral-medium-latest"
    system, user = call["messages"]
    assert system["role"] == "system"
    assert "Search Relevance Judge" in system["content"]
    assert json.loads(user["content"])["page"]["url"] == "chunk://x"


async def test_judge_relevance_retries_invalid_json(monkeypatch: pytest.MonkeyPatch) -> None:
    chat = _install(monkeypatch, ["not json", _LABEL_JSON])
    response = await relevance.judge_relevance("q", ResultPage(url="chunk://x"))
    assert response.score == 4
    assert len(chat.calls) == 2


async def test_judge_relevance_gives_up_after_three_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    chat = _install(monkeypatch, [json.dumps({**json.loads(_LABEL_JSON), "score": 9})])
    with pytest.raises(LLMResponseError):
        await relevance.judge_relevance("q", ResultPage(url="chunk://x"))
    assert len(chat.calls) == 3


async def test_search_llm_relevance_scorer() -> None:
    ctx = SimpleNamespace(
        output={"query": "net capital requirement", "page": {"url": "chunk://x", "title": None, "text": "answer"}},
        input_record={},
        system=SimpleNamespace(params={"judge_model": "mistral-small-latest"}),
        metadata={},
    )
    score = await scorers.search_llm_relevance.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.8)


async def test_judge_relevance_backs_off_through_rate_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 429 must be retried, not turned into a dropped record (it cost 13 of 15 records once)."""
    import httpx
    from mistralai.client import Mistral

    statuses = [429, 429, 200]
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        status = statuses[len(seen)]
        seen.append(status)
        if status == 429:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"message": "Rate limit exceeded"})
        return httpx.Response(
            200,
            json={
                "id": "c",
                "object": "chat.completion",
                "model": "mistral-small-latest",
                "created": 0,
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": _LABEL_JSON}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    def real_client(**kwargs: object) -> Mistral:
        assert kwargs.get("retry_config") is not None, "the judge client must carry a retry policy"
        return Mistral(**kwargs, async_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))  # type: ignore[arg-type]

    monkeypatch.setattr("evals.judge.JUDGE_RETRY_INITIAL_MS", 1)
    monkeypatch.setattr("evals.judge.JUDGE_RETRY_MAX_INTERVAL_MS", 5)
    monkeypatch.setattr("evals.search.relevance.Mistral", real_client)
    response = await relevance.judge_relevance("q", ResultPage(url="chunk://x"))
    assert response.score == 4
    assert seen == [429, 429, 200]


def _run_ctx(scores_per_record: list[dict[str, list[dict]]], *, task_errors: tuple[int, ...] = ()) -> object:
    from mistralai.evaluations.models import (
        EvaluationRunRecord,
        Generation,
        RunEvaluatorContext,
        RunEvaluatorRecord,
        _Score,
    )

    records = []
    for index, scores in enumerate(scores_per_record):
        failed = index in task_errors
        generation = Generation(
            output=None if failed else {"ok": True},
            status="error" if failed else "success",
            error="task boom" if failed else None,
            scores={name: [_Score(**score) for score in rows] for name, rows in scores.items()},
        )
        records.append(
            RunEvaluatorRecord(
                input={"query": str(index)},
                output=EvaluationRunRecord(input_record={"query": str(index)}, generations=[generation]),
            )
        )
    return RunEvaluatorContext(records=records, statistics={}, metadata={})


async def test_scorer_coverage_reports_dropped_judge_records() -> None:
    ok = {"value": 1.0}
    limited = {"value": None, "status": "error", "error": "SDKError 429 Rate limit exceeded"}
    ctx = _run_ctx(
        [{"search_mrr": [ok], "search_llm_relevance": [ok]}]
        + [{"search_mrr": [ok], "search_llm_relevance": [limited]}] * 3
    )
    score = await scorers.scorer_coverage.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.25)
    assert "search_llm_relevance scored 1/4" in score.rationale
    assert "429" in score.rationale
    assert score.metadata["search_llm_relevance"] == {
        "total": 4,
        "scored": 1,
        "failed": 3,
        "errors": ["SDKError 429 Rate limit exceeded"],
    }
    assert score.metadata["search_mrr"]["failed"] == 0


async def test_scorer_coverage_counts_a_failed_task_against_every_evaluator() -> None:
    ctx = _run_ctx([{"search_mrr": [{"value": 1.0}]}, {}], task_errors=(1,))
    score = await scorers.scorer_coverage.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.5)
    assert "task failed: task boom" in score.rationale


async def test_scorer_coverage_is_zero_when_every_task_fails() -> None:
    # A failed task carries no scores and the plugin computes no statistics, so no evaluator name
    # reaches the run evaluator. The run still dropped every record and must not read as covered.
    ctx = _run_ctx([{}, {}, {}], task_errors=(0, 1, 2))
    score = await scorers.scorer_coverage.__original_eval_fn__(ctx)
    assert score.value == 0.0
    assert "scored 0/3" in score.rationale
    assert "task failed: task boom" in score.rationale
    assert score.metadata["all evaluators"] == {
        "total": 3,
        "scored": 0,
        "failed": 3,
        "errors": ["task failed: task boom"],
    }


async def test_scorer_coverage_counts_a_record_with_no_generation() -> None:
    from mistralai.evaluations.models import EvaluationRunRecord, RunEvaluatorRecord

    ctx = _run_ctx([{"search_mrr": [{"value": 1.0}]}])
    # The plugin returns no generation at all when a record fails before its task runs.
    empty = EvaluationRunRecord(input_record={"query": "x"}, generations=[])
    ctx.records.append(RunEvaluatorRecord(input={"query": "x"}, output=empty))
    score = await scorers.scorer_coverage.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.5)
    assert "record produced no generation" in score.rationale


async def test_scorer_coverage_empty_run_is_zero() -> None:
    score = await scorers.scorer_coverage.__original_eval_fn__(_run_ctx([]))
    assert score.value == 0.0
    assert score.rationale == "no records were evaluated"


async def test_scorer_coverage_full_run_is_one() -> None:
    ctx = _run_ctx([{"search_mrr": [{"value": 0.5}]}] * 2)
    score = await scorers.scorer_coverage.__original_eval_fn__(ctx)
    assert score.value == 1.0


async def test_search_llm_relevance_no_page_is_zero() -> None:
    ctx = SimpleNamespace(output={"query": "q", "page": None}, input_record={}, system=None, metadata={})
    score = await scorers.search_llm_relevance.__original_eval_fn__(ctx)
    assert score.value == 0.0
