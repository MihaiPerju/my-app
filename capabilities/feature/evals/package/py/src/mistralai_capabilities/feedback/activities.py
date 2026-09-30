"""Chat-feedback activities: the loop network side effects.

Every step here is a network call, which is why they are activities: workflow code replays, so
running any of this in an entrypoint would re-read Studio and re-write the dataset. The
orchestration lives in the ``workflows`` package; the rating rules live in :mod:`.schemas`.
"""

import asyncio
from collections.abc import Awaitable, Callable, Coroutine, Iterable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, TypedDict, TypeVar

import structlog
from env.agents import env as agents_env
from env.mistral import env as mistral_env
from env.observability import env as observability_env
from env.workflows import env as workflows_env
from evals.judge import parse_rating
from mistralai import workflows
from mistralai.client import Mistral, models
from mistralai.client.utils.retries import BackoffStrategy, RetryConfig
from mistralai.workflows import Depends
from mistralai_capabilities.feedback.schemas import (
    DatasetRecords,
    DatasetRef,
    DatasetRequest,
    FeedbackBatch,
    FeedbackCase,
    FeedbackCases,
    FeedbackHarvestParams,
    PublishCandidateRequest,
    PublishedCandidate,
    SeedPrompt,
    build_cases,
    index_spans_by_id,
    relevance_prompt,
)

logger = structlog.get_logger("studio.feedback")

_SPAN_BATCH = 100
_CONCURRENCY = 8
_PAGE_SIZE = 100
_CANDIDATE_ALIAS = "candidate"
_MISTRAL_RETRY_CONFIG = RetryConfig(
    strategy="backoff",
    backoff=BackoffStrategy(initial_interval=100, max_interval=100, exponent=1.0, max_elapsed_time=100),
    retry_connection_errors=True,
)


def _mistral_client() -> Mistral:
    return Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)


class _StudioOptions(TypedDict):
    server_url: str
    timeout_ms: int
    retries: RetryConfig


class _Feed(Protocol):
    results: list[Any] | None
    next: object


_Response = TypeVar("_Response")


def _studio_options() -> _StudioOptions:
    return {
        "server_url": observability_env.observability_api_base_url.rstrip("/"),
        "timeout_ms": int(observability_env.observability_request_timeout_seconds * 1000),
        "retries": _MISTRAL_RETRY_CONFIG,
    }


def _quote_search_value(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _in_clause(field: str, values: Sequence[str]) -> str:
    return f"{field} IN ({', '.join(_quote_search_value(value) for value in values)})"


async def _find_prompt_by_name(client: Mistral, name: str) -> models.Prompt | None:
    page_token: str | None = None
    while True:
        page = await client.beta.prompts.list_async(
            page_size=_PAGE_SIZE,
            page_token=page_token,
            **_studio_options(),
        )
        if page is None:
            return None
        for prompt in page.result.data or []:
            if prompt.name == name:
                return prompt
        page_token = page.result.next_page_token
        if not page_token:
            return None


async def _list_datasets(client: Mistral) -> list[models.DatasetPreview]:
    rows: list[models.DatasetPreview] = []
    page = 1
    while True:
        response = await client.beta.observability.datasets.list_async(
            page_size=_PAGE_SIZE,
            page=page,
            **_studio_options(),
        )
        rows.extend(response.datasets.results or [])
        if not response.datasets.next:
            return rows
        page += 1


async def _list_records(client: Mistral, dataset_id: str) -> list[models.DatasetRecord]:
    rows: list[models.DatasetRecord] = []
    page = 1
    while True:
        response = await client.beta.observability.datasets.list_records_async(
            dataset_id=dataset_id,
            page_size=_PAGE_SIZE,
            page=page,
            **_studio_options(),
        )
        rows.extend(response.records.results or [])
        if not response.records.next:
            return rows
        page += 1


async def _search_paginated(
    search: Callable[..., Awaitable[_Response]],
    feed_of: Callable[[_Response], _Feed],
    *,
    operation: str,
    search_expression: str,
    from_timestamp: datetime,
    to_timestamp: datetime,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    for _page in range(observability_env.observability_max_pages):
        response = await search(
            search_expression=search_expression,
            from_=from_timestamp,
            to=to_timestamp,
            page_size=observability_env.observability_page_size,
            cursor=cursor,
            **_studio_options(),
        )
        feed = feed_of(response)
        rows.extend(row.model_dump(mode="json", by_alias=False) for row in feed.results or [])
        cursor = feed.next if isinstance(feed.next, str) and feed.next else None
        if cursor is None:
            return rows
    logger.warning(
        "search truncated at the page cap; older rows in this window were not read",
        operation=operation,
        pages=observability_env.observability_max_pages,
        rows=len(rows),
    )
    return rows


@workflows.activity(
    name="feedback.read_ratings",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def feedback_read_ratings(
    params: FeedbackHarvestParams,
    client: Mistral = Depends(_mistral_client),
) -> FeedbackCases:
    """Every rating in the window, joined to the exchange it judged."""
    if not mistral_env.mistral_api_key or not observability_env.observability_read_enabled:
        logger.warning("feedback harvest skipped: Studio reads are not enabled for this deployment")
        return FeedbackCases()

    to_timestamp = datetime.now(UTC)
    from_timestamp = to_timestamp - timedelta(hours=params.window_hours)
    spans_api = client.beta.observability.spans
    rows = await _search_paginated(
        spans_api.search_latest_span_evaluations_async,
        lambda response: response.span_evaluations,
        operation="search_latest_span_evaluations",
        search_expression=f"evaluation_name = {_quote_search_value(params.evaluation_name)}",
        from_timestamp=from_timestamp,
        to_timestamp=to_timestamp,
    )
    latest_by_span: dict[str, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda item: str(item.get("timestamp") or "")):
        span_id = str(row.get("span_id") or "")
        if span_id:
            latest_by_span[span_id] = row
    if not latest_by_span:
        logger.info("no ratings in window", hours=params.window_hours)
        return FeedbackCases()

    span_ids = list(latest_by_span)
    batches = [span_ids[start : start + _SPAN_BATCH] for start in range(0, len(span_ids), _SPAN_BATCH)]
    pages = await asyncio.gather(
        *(
            _search_paginated(
                spans_api.search_spans_async,
                lambda response: response.spans,
                operation="search_spans",
                search_expression=_in_clause("span_id", batch),
                from_timestamp=from_timestamp,
                to_timestamp=to_timestamp,
            )
            for batch in batches
        )
    )
    spans = [span for page in pages for span in page]

    cases = build_cases(evaluations=list(latest_by_span.values()), spans_by_id=index_spans_by_id(spans))
    logger.info("ratings harvested", ratings=len(latest_by_span), reconstructed=len(cases))
    return FeedbackCases(cases=cases)


@workflows.activity(
    name="feedback.judge_relevance",
    start_to_close_timeout=timedelta(seconds=600),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def feedback_judge_relevance(batch: FeedbackBatch, client: Mistral = Depends(_mistral_client)) -> FeedbackCases:
    """Score ratings for whether the exchange justifies them, keeping those above threshold."""

    async def judged(case: FeedbackCase) -> FeedbackCase:
        try:
            response = await client.chat.complete_async(
                model=batch.params.judge_model,
                messages=relevance_prompt(case),
            )
            case.relevance = parse_rating(str(response.choices[0].message.content))
            case.rationale = f"relevance judge ({batch.params.judge_model}) scored {case.relevance:.2f}"
        except Exception as error:
            case.relevance = 0.0
            case.rationale = f"relevance judge failed: {type(error).__name__}"
        return case

    scored = await _bounded_gather(judged(case) for case in batch.cases)
    kept = [case for case in scored if case.relevance >= batch.params.relevance_threshold]
    logger.info(
        "relevance judged",
        judged=len(batch.cases),
        kept=len(kept),
        threshold=batch.params.relevance_threshold,
    )
    return FeedbackCases(cases=kept)


@workflows.activity(
    name="feedback.write_dataset",
    start_to_close_timeout=timedelta(seconds=600),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def feedback_write_dataset(batch: FeedbackBatch, client: Mistral = Depends(_mistral_client)) -> DatasetRef:
    """Converge the day dataset on the cases that survived the judge."""
    window = datetime.now(UTC).strftime("%Y-%m-%d")
    name = f"{batch.params.dataset_name_prefix}-{window}"
    datasets_api = client.beta.observability.datasets

    dataset = next((item for item in await _list_datasets(client) if item.name == name), None)
    if dataset is None:
        dataset = await datasets_api.create_async(
            name=name,
            description=(
                f"Chat ratings from the {batch.params.window_hours}h window ending {window}, "
                f"kept where a relevance judge scored them >= {batch.params.relevance_threshold}."
            ),
            **_studio_options(),
        )
    if not dataset.id:
        raise RuntimeError(f"dataset lookup returned no id: {dataset!r}")
    dataset_id = dataset.id

    existing = await _list_records(client, dataset_id)
    already_filed = {str(record.properties.get("span_id") or "") for record in existing}
    missing = [case for case in batch.cases if case.span_id not in already_filed]

    await _bounded_gather(
        datasets_api.create_record_async(
            dataset_id=dataset_id,
            payload=case.dataset_payload(),
            properties=case.dataset_properties(),
            **_studio_options(),
        )
        for case in missing
    )
    logger.info(
        "dataset converged",
        dataset_id=dataset_id,
        name=name,
        appended=len(missing),
        already_filed=len(batch.cases) - len(missing),
    )
    return DatasetRef(
        dataset_id=dataset_id,
        name=name,
        records=len(existing) + len(missing),
        appended=len(missing),
    )


@workflows.activity(
    name="feedback.dataset_records",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def feedback_dataset_records(
    request: DatasetRequest, client: Mistral = Depends(_mistral_client)
) -> DatasetRecords:
    """Return dataset records as evaluation inputs."""
    dataset_id = request.dataset_id
    if not dataset_id:
        candidates = [
            dataset for dataset in await _list_datasets(client) if dataset.name.startswith(request.name_prefix)
        ]
        if not candidates:
            logger.warning("no harvested dataset found", prefix=request.name_prefix)
            return DatasetRecords()
        newest = max(candidates, key=lambda dataset: dataset.name)
        dataset_id = newest.id
        logger.info("resolved the latest harvest", dataset=newest.name, dataset_id=dataset_id)

    records = await _list_records(client, dataset_id)
    return DatasetRecords(records=[record.payload for record in records])


@workflows.activity(
    name="feedback.seed_prompt",
    start_to_close_timeout=timedelta(seconds=60),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def feedback_seed_prompt(
    client: Mistral = Depends(_mistral_client),
) -> SeedPrompt:
    """Return the registry prompt or an empty seed to use the promoted agent's instructions."""
    if not agents_env.prompt_registry_enabled:
        return SeedPrompt()
    prompt = await _find_prompt_by_name(client, agents_env.prompt_registry_name)
    if prompt is None or not prompt.id:
        return SeedPrompt()
    resolved = await client.beta.prompts.get_async(
        prompt_id=prompt.id,
        alias=agents_env.prompt_registry_alias,
        **_studio_options(),
    )
    content = resolved.definition.content if resolved.definition is not None else None
    return SeedPrompt(content=content if isinstance(content, str) and content.strip() else None)


@workflows.activity(
    name="feedback.publish_candidate",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def feedback_publish_candidate(
    request: PublishCandidateRequest,
    client: Mistral = Depends(_mistral_client),
) -> PublishedCandidate:
    """File the winning prompt as a new registry version under ``candidate``."""
    if not agents_env.prompt_registry_enabled:
        logger.info("candidate not published", reason="PROMPT_REGISTRY_ENABLED is off")
        return PublishedCandidate(reason="PROMPT_REGISTRY_ENABLED is off")

    prompt = await _find_prompt_by_name(client, agents_env.prompt_registry_name)
    if prompt is None:
        created = await client.beta.prompts.create_async(
            name=agents_env.prompt_registry_name,
            definition={"content": request.content},
            title="Solutions Capabilities orchestrator",
            description="System prompt for the root orchestrator agent.",
            notes=request.notes,
            aliases=[_CANDIDATE_ALIAS],
            **_studio_options(),
        )
        return PublishedCandidate(
            published=True,
            prompt_id=created.id,
            version=created.version,
            created=True,
        )

    if not prompt.id:
        raise RuntimeError(f"prompt lookup returned no id: {prompt!r}")
    version = await client.beta.prompts.create_version_async(
        prompt_id=prompt.id,
        definition={"content": request.content},
        notes=request.notes,
        aliases=[_CANDIDATE_ALIAS],
        **_studio_options(),
    )
    return PublishedCandidate(published=True, prompt_id=prompt.id, version=version.version)


async def _bounded_gather[T](coroutines: Iterable[Coroutine[Any, Any, T]]) -> list[T]:
    """Run the coroutines concurrently, at most ``_CONCURRENCY`` in flight."""
    semaphore = asyncio.Semaphore(_CONCURRENCY)

    async def guarded(coroutine: Coroutine[Any, Any, T]) -> T:
        async with semaphore:
            return await coroutine

    return list(await asyncio.gather(*(guarded(c) for c in coroutines)))
