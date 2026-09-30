"""Corpus search eval: grade the app's own retrieval over its ingested corpus against a gold set.

The synthetic ``search_evaluation`` track seeds an offline in-memory store with hash embeddings, so
it proves the harness works and says nothing about this app's corpus, chunking or ranking. This
track calls ``search_search`` itself -- the activity the agent calls, against the deployed backend
(hybrid dense + BM25 on postgres by default) -- once per gold query, and scores the source order it
returns with :func:`~mistralai_capabilities.search.retrieval_quality.source_metrics`.

The gold set is a JSON array of cases, one per query::

    [
      {"query": "How long do we keep payroll records?", "relevant_sources": ["policies/retention.md"]},
      {"query": "parental leave", "relevant_sources": ["hr/leave-*.md"], "notes": "free-form, ignored"}
    ]

``relevant_sources`` are ingested source ids, i.e. the object-storage keys ``bunx nx run
search:ingest`` indexed (the ``source_id`` column of ``search_sources``). Each entry matches one
source exactly, or several through an ``fnmatch`` glob. Any other key on a case is kept on the
record and ignored by the scorers.
"""

import json
from pathlib import Path
from typing import Any

from mistralai.workflows.plugins.evaluations.types import System, TaskContext
from mistralai_capabilities.search.retrieval_quality import source_metrics
from mistralai_capabilities.search.schemas import CorpusSearchResult, SearchRequest
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from evals.params import EvalParams

# Source-level cutoff. Fixed because the shipped scorers read `recall@10` / `ndcg@10`. It bounds the
# sources graded, not the sources retrieved: `top_k` counts chunks, and grouping by source returns
# up to `top_k` sources, so a run graded the ranking the configured search actually served. `top_k`
# is recorded in the run's system params, so runs with different settings are told apart.
SOURCE_CUTOFF = 10
_PAGE_TEXT_CHARS = 4000


class SourceGoldCase(BaseModel):
    """One gold-set case: a query and the source(s) that answer it."""

    model_config = ConfigDict(extra="allow")

    query: str = Field(min_length=1, description="The question, as a user would type it.")
    relevant_sources: list[str] = Field(
        min_length=1, description="Ingested source ids (exact, or fnmatch globs) that answer the query."
    )


_GOLD_SET = TypeAdapter(list[SourceGoldCase])


class EmptyGoldSetError(ValueError):
    """Raised when a corpus eval is asked to run with no cases."""


def validate_gold_set(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate raw gold-set records and return them as plain dicts (the dataset shape the plugin takes)."""
    if not records:
        raise EmptyGoldSetError(
            "The corpus search gold set is empty. Write one (see evals.search.corpus for the format) "
            "and pass it with --dataset."
        )
    return [case.model_dump() for case in _GOLD_SET.validate_python(records)]


def load_gold_set(path: Path) -> list[dict[str, Any]]:
    """Read and validate a gold-set JSON file."""
    return validate_gold_set(json.loads(path.read_text(encoding="utf-8")))


class SearchCorpusEvalParams(EvalParams):
    """Corpus-track run parameters. The retrieval knobs mirror ``SearchRequest``."""

    dataset: list[dict[str, Any]] = Field(
        default_factory=list, description="Gold cases ({query, relevant_sources}); required, the track ships none."
    )
    judge_model: str = Field(default="mistral-small-latest", description="Mistral model for the search-quality judge.")
    top_k: int = Field(
        default=10,
        ge=1,
        le=100,
        description=(
            "Chunks retrieved per query before grouping by source. The metrics grade the first "
            f"{SOURCE_CUTOFF} sources returned, which never exceed `top_k` (fewer when a source "
            "contributes several chunks): set it to what the agent's search uses, not to fill the cutoff."
        ),
    )
    hybrid: bool = Field(default=True, description="Fuse BM25 with the dense score, as the agent's search does.")
    rerank: bool = Field(default=False, description="Apply the LLM reranker before scoring.")

    def system(self) -> System:
        """The run's system label: the retrieval settings graded, recorded on the run in AI Studio."""
        return System(
            name=self.system_name,
            params={"judge_model": self.judge_model, "top_k": self.top_k, "hybrid": self.hybrid, "rerank": self.rerank},
        )


def corpus_search_request(params: dict[str, Any]) -> tuple[SourceGoldCase, SearchRequest]:
    """The gold case one task record carries, and the ``search_search`` request that answers it."""
    context = TaskContext.model_validate(params)
    case = SourceGoldCase.model_validate(context.input_record)
    settings = context.system.params if context.system is not None else {}
    request = SearchRequest(
        query=case.query,
        top_k=int(settings.get("top_k", 10)),
        hybrid=bool(settings.get("hybrid", True)),
        rerank=bool(settings.get("rerank", False)),
    )
    return case, request


def corpus_task_output(case: SourceGoldCase, result: CorpusSearchResult) -> dict[str, Any]:
    """The task output the search scorers read: ``metrics`` and the top source as a judgeable ``page``."""
    ranked = [group.source_id for group in result.groups]
    top = result.groups[0] if result.groups else None
    page = (
        {
            "url": top.url or f"source://{top.source_id}",
            "title": top.title,
            "text": "\n".join(hit.chunk.content for hit in top.results)[:_PAGE_TEXT_CHARS],
        }
        if top is not None
        else None
    )
    return {
        "query": case.query,
        "ranked_sources": ranked,
        "metrics": source_metrics(ranked, case.relevant_sources, k=SOURCE_CUTOFF),
        "page": page,
    }
