"""Feedback policy over a fake typed-shape Mistral SDK tree."""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from mistralai.client import models
from mistralai_capabilities.feedback import activities
from mistralai_capabilities.feedback.schemas import (
    NEGATIVE,
    DatasetRequest,
    FeedbackBatch,
    FeedbackCase,
    FeedbackHarvestParams,
    PublishCandidateRequest,
)

_NOW = datetime.now(UTC)


def _case(span_id: str) -> FeedbackCase:
    return FeedbackCase(
        message=f"q-{span_id}",
        prior_answer="a",
        rating=NEGATIVE,
        rating_score=0.0,
        trace_id="t",
        span_id=span_id,
    )


def _dataset(id: str, name: str) -> models.DatasetPreview:
    return models.DatasetPreview(
        id=id,
        created_at=_NOW,
        updated_at=_NOW,
        deleted_at=None,
        name=name,
        description="d",
        owner_id="owner",
        workspace_id="workspace",
    )


def _record(dataset_id: str, span_id: str, message: str | None = None) -> models.DatasetRecord:
    return models.DatasetRecord(
        id=f"r-{span_id}",
        created_at=_NOW,
        updated_at=_NOW,
        deleted_at=None,
        dataset_id=dataset_id,
        payload={"message": message or f"q-{span_id}"},
        properties={"span_id": span_id},
        source="DIRECT_INPUT",
    )


def _dataset_page(rows: list[models.DatasetPreview], nxt: object = None):
    return SimpleNamespace(datasets=SimpleNamespace(results=rows, next=nxt))


def _record_page(rows: list[models.DatasetRecord], nxt: object = None):
    return SimpleNamespace(records=SimpleNamespace(results=rows, next=nxt))


def _prompt_page(*rows: models.Prompt, token: str | None = None):
    return SimpleNamespace(result=SimpleNamespace(data=list(rows), next_page_token=token))


class _Row:
    def __init__(self, **values: object) -> None:
        self.values = values

    def model_dump(self, **kwargs: object) -> dict[str, object]:
        assert kwargs == {"mode": "json", "by_alias": False}
        return self.values


def _search_page(key: str, rows: list[_Row], nxt: object = None):
    return SimpleNamespace(**{key: SimpleNamespace(results=rows, next=nxt)})


class _FakeMistral:
    def __init__(self) -> None:
        self.prompts = SimpleNamespace(
            list_async=AsyncMock(),
            get_async=AsyncMock(),
            create_async=AsyncMock(),
            create_version_async=AsyncMock(),
        )
        self.datasets = SimpleNamespace(
            list_async=AsyncMock(),
            create_async=AsyncMock(),
            list_records_async=AsyncMock(),
            create_record_async=AsyncMock(),
        )
        self.spans = SimpleNamespace(
            search_latest_span_evaluations_async=AsyncMock(),
            search_spans_async=AsyncMock(),
        )
        self.chat = SimpleNamespace(complete_async=AsyncMock())
        self.beta = SimpleNamespace(
            prompts=self.prompts,
            observability=SimpleNamespace(datasets=self.datasets, spans=self.spans),
        )


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(activities.mistral_env, "mistral_api_key", "sk-test")
    monkeypatch.setattr(activities.observability_env, "observability_read_enabled", True)
    monkeypatch.setattr(activities.observability_env, "observability_page_size", 2)
    monkeypatch.setattr(activities.observability_env, "observability_max_pages", 5)
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", False)
    monkeypatch.setattr(
        activities.agents_env,
        "prompt_registry_name",
        "mistralai-capabilities-orchestrator",
    )


async def test_dataset_helpers_follow_every_page_and_pass_studio_options() -> None:
    client = _FakeMistral()
    client.datasets.list_async.side_effect = [
        _dataset_page([_dataset("old", "old")], "next"),
        _dataset_page([_dataset("new", "new")]),
    ]
    client.datasets.list_records_async.side_effect = [
        _record_page([_record("new", "s1")], "next"),
        _record_page([_record("new", "s2")]),
    ]

    assert [row.id for row in await activities._list_datasets(client)] == ["old", "new"]
    assert [row.id for row in await activities._list_records(client, "new")] == [
        "r-s1",
        "r-s2",
    ]
    assert client.datasets.list_async.await_args_list[1].kwargs["page"] == 2
    options = client.datasets.list_records_async.await_args.kwargs
    assert options["server_url"] == activities.observability_env.observability_api_base_url
    assert options["timeout_ms"] == int(activities.observability_env.observability_request_timeout_seconds * 1000)
    assert options["retries"] is activities._MISTRAL_RETRY_CONFIG


async def test_first_run_creates_dataset_and_files_every_case() -> None:
    client = _FakeMistral()
    client.datasets.list_async.return_value = _dataset_page([])
    client.datasets.create_async.return_value = _dataset("ds-1", "today")
    client.datasets.list_records_async.return_value = _record_page([])
    batch = FeedbackBatch(params=FeedbackHarvestParams(), cases=[_case("s1"), _case("s2")])

    result = await activities.feedback_write_dataset.__original_func__(batch, client)

    assert result.appended == 2
    assert result.records == 2
    assert sorted(
        call.kwargs["properties"]["span_id"] for call in client.datasets.create_record_async.await_args_list
    ) == ["s1", "s2"]


async def test_interrupted_dataset_convergence_appends_only_missing_records() -> None:
    client = _FakeMistral()
    today = f"chat-feedback-{datetime.now(UTC):%Y-%m-%d}"
    client.datasets.list_async.return_value = _dataset_page([_dataset("ds-1", today)])
    client.datasets.list_records_async.return_value = _record_page([_record("ds-1", "s1")])
    batch = FeedbackBatch(params=FeedbackHarvestParams(), cases=[_case("s1"), _case("s2"), _case("s3")])

    result = await activities.feedback_write_dataset.__original_func__(batch, client)

    assert result.appended == 2
    assert result.records == 3
    assert [call.kwargs["properties"]["span_id"] for call in client.datasets.create_record_async.await_args_list] == [
        "s2",
        "s3",
    ]
    client.datasets.create_async.assert_not_awaited()


async def test_dataset_records_resolves_newest_harvest_and_all_record_pages() -> None:
    client = _FakeMistral()
    client.datasets.list_async.return_value = _dataset_page(
        [
            _dataset("old", "chat-feedback-2026-07-30"),
            _dataset("new", "chat-feedback-2026-08-01"),
            _dataset("other", "unrelated"),
        ]
    )
    client.datasets.list_records_async.side_effect = [
        _record_page([_record("new", "s1", "new-1")], "next"),
        _record_page([_record("new", "s2", "new-2")]),
    ]

    resolved = await activities.feedback_dataset_records.__original_func__(
        DatasetRequest(name_prefix="chat-feedback"), client
    )

    assert resolved.records == [{"message": "new-1"}, {"message": "new-2"}]
    assert client.datasets.list_records_async.await_args.kwargs["dataset_id"] == "new"


async def test_dataset_records_prefers_explicit_id() -> None:
    client = _FakeMistral()
    client.datasets.list_records_async.return_value = _record_page([_record("ds-a", "s1", "a")])

    resolved = await activities.feedback_dataset_records.__original_func__(DatasetRequest(dataset_id="ds-a"), client)

    assert resolved.records == [{"message": "a"}]
    client.datasets.list_async.assert_not_awaited()


async def test_two_cursor_page_feedback_read_keeps_latest_verdict() -> None:
    client = _FakeMistral()
    client.spans.search_latest_span_evaluations_async.side_effect = [
        _search_page(
            "span_evaluations",
            [
                _Row(
                    span_id="s1",
                    timestamp="2026-08-01T09:00:00Z",
                    score_label="positive",
                    score_value=1.0,
                )
            ],
            "c1",
        ),
        _search_page(
            "span_evaluations",
            [
                _Row(
                    span_id="s1",
                    timestamp="2026-08-01T10:00:00Z",
                    score_label="negative",
                    score_value=0.0,
                )
            ],
        ),
    ]
    client.spans.search_spans_async.side_effect = [
        _search_page("spans", [_Row(span_id="s1", span_attributes={})], "c2"),
        _search_page(
            "spans",
            [
                _Row(
                    span_id="s1",
                    span_attributes={
                        "gen_ai.input.messages": [{"role": "user", "content": "q"}],
                        "gen_ai.output.messages": [{"role": "assistant", "content": "a"}],
                    },
                )
            ],
        ),
    ]

    harvested = await activities.feedback_read_ratings.__original_func__(FeedbackHarvestParams(), client)

    assert len(harvested.cases) == 1
    assert harvested.cases[0].rating == NEGATIVE
    assert client.spans.search_latest_span_evaluations_async.await_args_list[1].kwargs["cursor"] == "c1"
    assert client.spans.search_spans_async.await_args_list[1].kwargs["cursor"] == "c2"


async def test_search_page_cap_returns_collected_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    monkeypatch.setattr(activities.observability_env, "observability_max_pages", 2)
    client.spans.search_latest_span_evaluations_async.return_value = _search_page(
        "span_evaluations", [_Row(span_id="x")], "more"
    )

    rows = await activities._search_paginated(
        client.spans.search_latest_span_evaluations_async,
        lambda response: response.span_evaluations,
        operation="test",
        search_expression="x",
        from_timestamp=_NOW,
        to_timestamp=_NOW,
    )

    assert rows == [{"span_id": "x"}, {"span_id": "x"}]
    assert client.spans.search_latest_span_evaluations_async.await_count == 2


async def test_harvest_disabled_is_noop_before_sdk_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    monkeypatch.setattr(activities.observability_env, "observability_read_enabled", False)

    result = await activities.feedback_read_ratings.__original_func__(FeedbackHarvestParams(), client)

    assert result.cases == []
    client.spans.search_latest_span_evaluations_async.assert_not_awaited()


async def test_prompt_lookup_and_seed_follow_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    client.prompts.list_async.side_effect = [
        _prompt_page(models.Prompt(id="other", name="other"), token="next"),
        _prompt_page(models.Prompt(id="p-1", name="mistralai-capabilities-orchestrator")),
    ]
    client.prompts.get_async.return_value = models.Prompt(definition={"content": "live"})
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", True)

    seed = await activities.feedback_seed_prompt.__original_func__(client)

    assert seed.content == "live"
    assert client.prompts.list_async.await_args_list[1].kwargs["page_token"] == "next"
    assert client.prompts.get_async.await_args.kwargs["retries"] is activities._MISTRAL_RETRY_CONFIG


async def test_seed_missing_prompt_id_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    client.prompts.list_async.return_value = _prompt_page(models.Prompt(name="mistralai-capabilities-orchestrator"))
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", True)

    assert (await activities.feedback_seed_prompt.__original_func__(client)).content is None
    client.prompts.get_async.assert_not_awaited()


async def test_typed_candidate_creation_never_assigns_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    client.prompts.list_async.return_value = _prompt_page()
    client.prompts.create_async.return_value = models.Prompt(id="p-1", version=1)
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", True)

    result = await activities.feedback_publish_candidate.__original_func__(
        PublishCandidateRequest(content="evolved", notes="n"), client
    )

    assert result.published is True
    assert result.created is True
    assert client.prompts.create_async.await_args.kwargs["aliases"] == ["candidate"]
    assert "production" not in client.prompts.create_async.await_args.kwargs["aliases"]


async def test_existing_candidate_version_never_assigns_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    client.prompts.list_async.return_value = _prompt_page(
        models.Prompt(id="p-1", name="mistralai-capabilities-orchestrator")
    )
    client.prompts.create_version_async.return_value = models.CreatePromptVersionResponse(version=4, deduplicated=False)
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", True)

    result = await activities.feedback_publish_candidate.__original_func__(
        PublishCandidateRequest(content="evolved", notes="n"), client
    )

    assert result.version == 4
    assert client.prompts.create_version_async.await_args.kwargs["aliases"] == ["candidate"]


async def test_candidate_missing_prompt_id_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    client.prompts.list_async.return_value = _prompt_page(models.Prompt(name="mistralai-capabilities-orchestrator"))
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", True)

    with pytest.raises(RuntimeError, match=r"prompt lookup returned no id:"):
        await activities.feedback_publish_candidate.__original_func__(
            PublishCandidateRequest(content="evolved", notes="n"), client
        )


async def test_prompt_activities_are_disabled_without_sdk_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeMistral()
    monkeypatch.setattr(activities.agents_env, "prompt_registry_enabled", False)

    seed = await activities.feedback_seed_prompt.__original_func__(client)
    published = await activities.feedback_publish_candidate.__original_func__(
        PublishCandidateRequest(content="evolved", notes="n"), client
    )

    assert seed.content is None
    assert published.published is False
    client.prompts.list_async.assert_not_awaited()


class _FakeJudge:
    def __init__(self, *replies: str | Exception) -> None:
        self.replies = list(replies)
        self.chat = SimpleNamespace(complete_async=self._complete)

    async def _complete(self, **_kwargs: Any) -> Any:
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=reply))])


async def test_judge_keeps_only_ratings_above_threshold() -> None:
    batch = FeedbackBatch(
        params=FeedbackHarvestParams(relevance_threshold=0.5),
        cases=[_case("keep"), _case("drop")],
    )
    kept = await activities.feedback_judge_relevance.__original_func__(batch, _FakeJudge("8", "2"))
    assert [case.span_id for case in kept.cases] == ["keep"]


async def test_one_judge_failure_costs_one_case_not_harvest() -> None:
    batch = FeedbackBatch(params=FeedbackHarvestParams(), cases=[_case("boom"), _case("fine")])
    kept = await activities.feedback_judge_relevance.__original_func__(
        batch, _FakeJudge(RuntimeError("upstream 500"), "9")
    )
    assert [case.span_id for case in kept.cases] == ["fine"]
