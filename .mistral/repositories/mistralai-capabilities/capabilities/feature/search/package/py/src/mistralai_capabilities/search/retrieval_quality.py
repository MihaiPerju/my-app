"""Retrieval-quality (IR) evaluation for the ``search`` feature.

Two modes. The synthetic mode measures chunk-level relevance with standard IR metrics (Recall@k,
NDCG@k, MRR, MAP) over a fixed offline corpus, using the toolkit's :class:`RetrieverEvaluator`;
``embed_fn`` is injected, so it runs in CI with deterministic hash embeddings and needs no key. It
exercises the harness, not the product: it never touches an ingested corpus.

The corpus mode grades the app's own ranking. The ``evals`` capability's corpus track runs
``search_search`` (the activity the agent calls, hybrid over the deployed backend) per gold query,
and :func:`source_metrics` scores the source order it returns against the gold sources.
"""

import math
from collections.abc import Awaitable, Callable
from fnmatch import fnmatchcase

import structlog
from mistralai.search.toolkit.evals import (
    EvaluationDataset,
    EvaluationQuery,
    RetrievalMetrics,
    RetrievalStepResult,
    RetrieverEvaluator,
)
from mistralai.search.toolkit.evals.models import EvaluationSummary

from mistralai_capabilities.search.evaluation import (
    build_synthetic_case,
    hash_embedding,
    seed_case,
)
from mistralai_capabilities.search.local_store import get_local_store, reset_local_stores
from mistralai_capabilities.search.schemas import FilteredVectorSearchQuery
from mistralai_capabilities.search.store import SearchStore

logger = structlog.get_logger(__name__)

EmbedFn = Callable[[str], list[float]]
RetrievalWorkflow = Callable[[str], Awaitable[list[RetrievalStepResult]]]

DEFAULT_METADATA_KEYS = ["page_number"]
DEFAULT_K_VALUES = [1, 3, 5, 10]
VECTOR_STEP = "vector"


def make_store_workflow(
    store: SearchStore,
    embed_fn: EmbedFn,
    *,
    top_k: int = 10,
    step_name: str = VECTOR_STEP,
    k_values: list[int] | None = None,
    hybrid: bool = True,
) -> RetrievalWorkflow:
    """Adapt a :class:`SearchStore` into a toolkit evaluation workflow.

    The returned callable embeds the query, runs one corpus retrieval, and wraps the hits in one
    :class:`RetrievalStepResult`. ``hybrid`` defaults to true to grade the ranking ``search_search``
    serves; pass ``hybrid=False`` for the dense arm alone.

    The toggle is the query TEXT, exactly as in ``_run_search`` -- no backend defines
    ``hybrid_search`` any more, and the postgres plugin fuses lexically whenever ``query.query``
    is non-empty. Feature-detecting a method here while the activity blanks the text would grade
    a ranking the product does not serve, which is the drift this harness exists to prevent.
    """

    async def workflow(query: str) -> list[RetrievalStepResult]:
        request = FilteredVectorSearchQuery(
            embedding=embed_fn(query), query=query if hybrid else "", top_k=top_k, exclude_ids=set()
        )
        results = await store.search(request)
        return [RetrievalStepResult(step_name=step_name, results=results, top_k=top_k, k_values=k_values)]

    return workflow


async def run_retrieval_quality_eval(
    store: SearchStore,
    dataset: EvaluationDataset,
    *,
    embed_fn: EmbedFn,
    top_k: int = 10,
    k_values: list[int] | None = None,
    metadata_keys: list[str] | None = None,
    step_name: str = VECTOR_STEP,
    batch_size: int = 10,
    max_concurrent_batches: int = 3,
    hybrid: bool = True,
) -> EvaluationSummary:
    """Grade a store's retrieval against ``dataset`` and return the IR summary.

    ``metadata_keys`` drives ``relevant_reference_ids`` proxy matching (defaults
    to page-level). Queries carrying exact ``relevant_ids`` bypass proxies.
    """
    resolved_k = k_values or DEFAULT_K_VALUES
    evaluator = RetrieverEvaluator(k_values=resolved_k, metadata_keys=metadata_keys or DEFAULT_METADATA_KEYS)
    workflow = make_store_workflow(
        store, embed_fn, top_k=top_k, step_name=step_name, k_values=resolved_k, hybrid=hybrid
    )
    summary = await evaluator.evaluate_workflow_dataset_batch(
        dataset,
        workflow,
        batch_size=batch_size,
        max_concurrent_batches=max_concurrent_batches,
    )
    logger.info(
        "Retrieval quality eval completed",
        dataset=dataset.name,
        queries=summary.total_queries,
        steps=list(summary.workflow_metrics_avg),
    )
    return summary


def flatten_metrics(metrics: RetrievalMetrics) -> dict[str, float]:
    """Flatten a :class:`RetrievalMetrics` into scalar ``metric@k`` keys.

    Produces stable names (``recall@10``, ``ndcg@10``, ``mrr``, ``map``, ``hit_rate``,
    ``coverage``, ``perfect_recall``) for scorer extraction. Only populated fields emit.
    """
    flat: dict[str, float] = {}
    for k, value in metrics.recall_at_k.items():
        flat[f"recall@{k}"] = value
    for k, value in metrics.precision_at_k.items():
        flat[f"precision@{k}"] = value
    for k, value in metrics.f1_at_k.items():
        flat[f"f1@{k}"] = value
    for k, value in metrics.ndcg_at_k.items():
        flat[f"ndcg@{k}"] = value
    for name, value in (
        ("mrr", metrics.mrr),
        ("map", metrics.map),
        ("hit_rate", metrics.hit_rate),
        ("coverage", metrics.coverage),
        ("perfect_recall", metrics.perfect_recall),
    ):
        if value is not None:
            flat[name] = value
    return flat


def source_matches(source_id: str, pattern: str) -> bool:
    """Whether a ranked ``source_id`` satisfies one gold-set entry.

    An entry is an ingested source id (the object-storage key, e.g. ``policies/leave.md``) matched
    exactly, or an ``fnmatch`` glob (``policies/leave*``) when a key is not stable enough to pin.
    Exact by default so a gold set cannot pass by accident on a loose fragment.
    """
    return source_id == pattern or fnmatchcase(source_id, pattern)


def _credited_ranks(ranked_source_ids: list[str], gold: list[str]) -> list[int]:
    """The ranks credited by a one-to-one assignment of ranked sources to gold entries.

    Crediting each source to the first free entry it matches depends on gold order: with gold
    ``["docs/*", "docs/a.md"]`` and ranking ``["docs/a.md", "docs/b.md"]`` the glob takes rank 0
    and rank 1 is left with nothing. Instead, each rank in order looks for an augmenting path
    (Kuhn's algorithm), which may move an earlier rank to another entry but never un-credits it.
    Assignments form a transversal matroid, so this rank-ordered greedy credits the most entries
    and, among those, the earliest ranks: recall, nDCG and MRR are all at their best assignment.
    """
    owner: dict[str, int] = {}  # gold entry -> rank credited to it

    def assign(rank: int, seen: set[str]) -> bool:
        for entry in gold:
            if entry in seen or not source_matches(ranked_source_ids[rank], entry):
                continue
            seen.add(entry)
            if entry not in owner or assign(owner[entry], seen):
                owner[entry] = rank
                return True
        return False

    return sorted(rank for rank in range(len(ranked_source_ids)) if assign(rank, set()))


def source_metrics(ranked_source_ids: list[str], relevant_sources: list[str], *, k: int = 10) -> dict[str, float]:
    """Source-level IR metrics for one query over the real corpus ranking.

    ``ranked_source_ids`` is the order ``search_search`` groups its hits in; ``relevant_sources``
    are the gold entries (see :func:`source_matches`). Each gold entry is credited to at most one
    ranked source and each source to at most one entry, so a glob that matches several sources
    cannot push nDCG above 1. When entries overlap (``docs/*`` and ``docs/a.md``) the credit is
    an assignment, not first-come: see :func:`_credited_ranks`. Returns ``recall@k``, ``ndcg@k``
    (binary gain), ``mrr`` and ``hit_rate``, the same names :func:`flatten_metrics` emits, so the
    shipped search scorers read either mode unchanged.
    """
    gold = list(dict.fromkeys(relevant_sources))
    hit_ranks = _credited_ranks(ranked_source_ids[:k], gold)
    dcg = sum(1.0 / math.log2(rank + 2) for rank in hit_ranks)
    ideal = sum(1.0 / math.log2(rank + 2) for rank in range(min(len(gold), k)))
    return {
        f"recall@{k}": len(hit_ranks) / len(gold) if gold else 0.0,
        f"ndcg@{k}": dcg / ideal if ideal else 0.0,
        "mrr": 1.0 / (hit_ranks[0] + 1) if hit_ranks else 0.0,
        "hit_rate": 1.0 if hit_ranks else 0.0,
    }


def build_synthetic_retrieval_dataset(collection: str = "retrieval_quality_eval") -> EvaluationDataset:
    """A one-query gold set over the synthetic long-document case.

    The gold answer sits on page 12, outside the top-1 hit, so the metrics exercise ranking beyond
    rank 1. It uses the ``page_number`` proxy for labels stable across re-chunking.
    """
    _, case = build_synthetic_case(collection)
    return EvaluationDataset(
        queries=[
            EvaluationQuery(
                query=case.search_query,
                relevant_ids=[],
                relevant_reference_ids=["page_number_12"],
                metadata={"collection": case.collection},
            )
        ],
        name="synthetic_retrieval_quality",
        description="Offline single-query retrieval-quality gold set (answer on page 12).",
    )


async def seed_synthetic_store(collection: str = "retrieval_quality_eval") -> SearchStore:
    """Idempotently seed the synthetic long-document corpus into a local store.

    ``index_document`` overwrites chunks per source, so repeated calls converge
    to the same corpus — safe to call once per eval record on the worker.
    """
    document, case = build_synthetic_case(collection)
    store = get_local_store(case.collection)
    await seed_case(store, document, case)
    return store


async def score_query(
    query: str,
    relevant_reference_ids: list[str],
    *,
    collection: str = "retrieval_quality_eval",
    top_k: int = 10,
    k_values: list[int] | None = None,
) -> dict[str, float]:
    """Seed the offline synthetic corpus and return flat IR metrics for one query."""
    store = await seed_synthetic_store(collection)
    dataset = EvaluationDataset(
        queries=[EvaluationQuery(query=query, relevant_ids=[], relevant_reference_ids=relevant_reference_ids)],
        name="search_retrieval_record",
    )
    summary = await run_retrieval_quality_eval(store, dataset, embed_fn=hash_embedding, top_k=top_k, k_values=k_values)
    step = summary.workflow_metrics_avg.get(VECTOR_STEP)
    return flatten_metrics(step) if step is not None else {}


async def top_hit_page(store: SearchStore, query: str, *, embed_fn: EmbedFn) -> dict[str, str | None] | None:
    """Return the top vector hit as a page dict (``url``/``title``/``text``) or None."""
    hits = await store.search(FilteredVectorSearchQuery(embedding=embed_fn(query), top_k=1, exclude_ids=set()))
    if not hits:
        return None
    chunk = hits[0].chunk
    return {"url": f"chunk://{chunk.id}", "title": None, "text": chunk.content}


async def score_and_probe(
    query: str,
    relevant_reference_ids: list[str],
    *,
    collection: str = "retrieval_quality_eval",
    top_k: int = 10,
    k_values: list[int] | None = None,
) -> tuple[dict[str, float], dict[str, str | None] | None]:
    """Return flat IR metrics for ``query`` plus its top hit as a judgeable page."""
    store = await seed_synthetic_store(collection)
    dataset = EvaluationDataset(
        queries=[EvaluationQuery(query=query, relevant_ids=[], relevant_reference_ids=relevant_reference_ids)],
        name="search_retrieval_record",
    )
    summary = await run_retrieval_quality_eval(store, dataset, embed_fn=hash_embedding, top_k=top_k, k_values=k_values)
    step = summary.workflow_metrics_avg.get(VECTOR_STEP)
    metrics = flatten_metrics(step) if step is not None else {}
    page = await top_hit_page(store, query, embed_fn=hash_embedding)
    return metrics, page


async def run_synthetic_retrieval_quality_eval(
    *,
    top_k: int = 10,
    k_values: list[int] | None = None,
) -> EvaluationSummary:
    """Seed a fresh :class:`LocalSearchStore` and grade it offline (hash embeddings).

    Self-contained: no external services, no credentials. Suitable for tests and
    for the ``eval-search`` runner's offline mode.
    """
    reset_local_stores()
    document, case = build_synthetic_case()
    store = get_local_store(case.collection)
    await seed_case(store, document, case)
    dataset = build_synthetic_retrieval_dataset(case.collection)
    return await run_retrieval_quality_eval(
        store,
        dataset,
        embed_fn=hash_embedding,
        top_k=top_k,
        k_values=k_values,
    )
