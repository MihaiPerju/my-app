"""Search retrieval evaluation config: params, evaluator wiring, and task helpers.

This owns the "what to evaluate and how to score it" for the search track.
The workflow classes in ``apps/worker/src/worker/workflows/evals.py`` import from here and own only
the Temporal orchestration.
"""

from typing import Any

from mistralai.workflows.plugins.evaluations.types import Evaluator, Goal, RunEvaluator, TaskContext
from pydantic import Field

from evals.params import EvalParams
from evals.scorers import (
    scorer_coverage_evaluator,
    search_llm_relevance,
    search_mean_recall_at_10,
    search_mrr,
    search_ndcg_at_10,
    search_recall_at_10,
)


class SearchEvalParams(EvalParams):
    """Search-track run parameters; same shape as every track, with domain-worded descriptions."""

    dataset: list[dict[str, Any]] = Field(default_factory=list, description="Cases to run; empty uses the gold set.")
    judge_model: str = Field(default="mistral-small-latest", description="Mistral model for the search-quality judge.")


def search_record(params: dict[str, Any]) -> tuple[str, list[str], str]:
    record = TaskContext.model_validate(params).input_record
    query = str(record["query"])
    gold = [str(ref) for ref in (record.get("relevant_reference_ids") or [])]
    collection = str(record.get("collection") or "retrieval_quality_eval")
    return query, gold, collection


def build_search_evaluators() -> list[Evaluator]:
    return [
        Evaluator(
            name="search_recall_at_10",
            description="Recall@10 of the gold items (pages on the synthetic track, sources on the corpus track).",
            scorer=search_recall_at_10,
            goal=Goal.gte(0.5),
        ),
        Evaluator(
            name="search_ndcg_at_10",
            description="NDCG@10 of the retrieval ranking.",
            scorer=search_ndcg_at_10,
            goal=Goal.gte(0.3),
        ),
        Evaluator(
            name="search_mrr",
            description="Mean reciprocal rank of the first gold hit.",
            scorer=search_mrr,
            goal=Goal.gte(0.3),
        ),
        Evaluator(
            name="search_llm_relevance",
            description="Mistral search-quality LLM judge: relevance of the top hit (0-5, normalized).",
            scorer=search_llm_relevance,
            goal=Goal.gte(0.6),
        ),
    ]


def build_search_run_evaluators() -> list[RunEvaluator]:
    return [
        RunEvaluator(
            name="search_mean_recall_at_10",
            description="Mean recall@10 across queries.",
            scorer=search_mean_recall_at_10,
            goal=Goal.gte(0.5),
        ),
        scorer_coverage_evaluator(),
    ]
