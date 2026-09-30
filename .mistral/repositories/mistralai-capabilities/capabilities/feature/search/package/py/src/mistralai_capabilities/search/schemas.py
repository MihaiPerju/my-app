"""Loop-boundary contract for the Agentic Search (``search``) feature.

The store, activities, workflows, agent tools, and the generated OpenAPI client all import this
single type boundary, so field names and the failure taxonomy are frozen. ``SearchResult`` and
``SearchResultChunk`` from the Search Toolkit SDK are the wire shape, grouped by
:class:`SourceGroup`. Expected failures are typed :class:`OperationFailure` outcomes.
"""

from datetime import datetime
from typing import Literal, Self

from env.ingestion import env as ingestion_env

from mistralai.search.toolkit.document import ChunkType
from mistralai.search.toolkit.search.models import (
    SearchResult,
    SearchResultChunk,
    VectorSearchQuery,
)
from pydantic import BaseModel, Field, model_validator

# Fallback pair for a CollectionConfig nobody has configured yet. They move together: embed_dim is
# the physical vector width of the model named beside it.
_DEFAULT_EMBED_MODEL = "mistral-embed-dim128-2510"
_DEFAULT_EMBED_DIM = 128
_DEFAULT_RERANK_MODEL = "mistral-small-latest"
# Deployment-wide constants, derived from the settings rather than restated so the two cannot drift
# apart. The collection is a persisted primary-key value; changing it strands the existing corpus.
# The embedding model is the one `register_search_pipelines` builds every pipeline's embedder with,
# so a request naming a different one would size the collection for vectors nothing will produce.
_DEFAULT_COLLECTION = ingestion_env.ingestion_collection_name
_DEPLOYMENT_EMBED_MODEL = ingestion_env.ingestion_embed_model
_DEFAULT_TOP_K = 5
_DEFAULT_WINDOW = 1
# Mirrors `top_k`'s ceiling, and bounds a cost `top_k` does not have: `LLMReRanker` scores one
# candidate per LLM call, awaited serially, so this many candidates is this many round trips
# inside the 300s `search_search` timeout.
_MAX_RERANK_CANDIDATES = 100
_CHUNKING_VERSION = "atoms-1"

_MAX_BUSINESS_ID_LEN = 255

__all__ = [
    "ChunkType",
    "CollectionConfig",
    "CollectionConfigMismatchError",
    "CorpusSearchResult",
    "DeleteRequest",
    "DeleteResult",
    "EnsureCollectionRequest",
    "EnumerateRequest",
    "EnumerateResult",
    "FailureKind",
    "FilteredVectorSearchQuery",
    "GrepMode",
    "GrepRequest",
    "GrepResult",
    "NavigateDirection",
    "NavigateRequest",
    "NavigateResult",
    "OpenRequest",
    "OpenResult",
    "OperationFailure",
    "ReadRequest",
    "ReadResult",
    "ReconcileAction",
    "ReconcileItem",
    "ReconcilePlan",
    "ReconcilePlanRequest",
    "ReconcileRequest",
    "ReconcileResult",
    "ReconcileSettings",
    "RecordIngestedRequest",
    "RecordIngestedResult",
    "ReindexAnnRequest",
    "ReindexAnnResult",
    "SearchRequest",
    "SearchResult",
    "SearchResultChunk",
    "SourceGroup",
    "SourceMeta",
    "SourceSnapshotItem",
    "TombstoneGcRequest",
    "TombstoneGcResult",
    "group_results",
]


class FilteredVectorSearchQuery(VectorSearchQuery):
    """Vector query extended with exact-match metadata filters for corpus search."""

    filters: dict[str, str] = Field(default_factory=dict, description="Exact-match metadata filters.")


FailureKind = Literal[
    "not_found",
    "blocked",
    "transient",
    "unsupported",
    "budget_exhausted",
]


class OperationFailure(BaseModel):
    """A typed, expected failure outcome (not an infrastructure exception)."""

    kind: FailureKind = Field(description="Failure class for the operation.")
    message: str = Field(description="Human-readable explanation of the failure.")
    detail: dict[str, str] = Field(default_factory=dict, description="Structured failure context.")


class SourceGroup(BaseModel):
    """Results belonging to one source, with source metadata factored onto the group."""

    source_id: str = Field(description="Stable source identity shared by the results.")
    filename: str | None = Field(default=None, description="Display filename for the source.")
    url: str | None = Field(default=None, description="Origin URL for the source, when applicable.")
    title: str | None = Field(default=None, description="Human title for the source, when known.")
    metadata: dict[str, str] = Field(default_factory=dict, description="Source-level metadata.")
    results: list[SearchResult] = Field(default_factory=list, description="Results in ascending source order.")


class SourceMeta(BaseModel):
    """Source-level metadata used to build :class:`SourceGroup`s from bare results."""

    source_id: str
    filename: str | None = None
    url: str | None = None
    title: str | None = None
    metadata: dict[str, str] = Field(default_factory=dict)


def group_results(results: list[SearchResult], sources: dict[str, SourceMeta] | None = None) -> list[SourceGroup]:
    """Group results by source, preserving first-seen source order and result order.

    Source metadata is factored onto the group. When ``sources`` lacks an entry
    the group falls back to bare source identity.
    """
    sources = sources or {}
    order: list[str] = []
    by_source: dict[str, list[SearchResult]] = {}
    for result in results:
        source_id = result.chunk.source_id
        if source_id not in by_source:
            by_source[source_id] = []
            order.append(source_id)
        by_source[source_id].append(result)

    groups: list[SourceGroup] = []
    for source_id in order:
        meta = sources.get(source_id)
        groups.append(
            SourceGroup(
                source_id=source_id,
                filename=meta.filename if meta else None,
                url=meta.url if meta else None,
                title=meta.title if meta else None,
                metadata=dict(meta.metadata) if meta else {},
                results=by_source[source_id],
            )
        )
    return groups


class CollectionConfig(BaseModel):
    """Persisted collection state so ingest and search cannot silently disagree."""

    collection_name: str
    embed_model: str = _DEFAULT_EMBED_MODEL
    embed_dim: int = Field(default=_DEFAULT_EMBED_DIM, ge=1)
    chunking_version: str = _CHUNKING_VERSION


class CollectionConfigMismatchError(RuntimeError):
    """Raised when a request's embedding config conflicts with the stored collection."""


class UnsupportedSearchFilterError(RuntimeError):
    """Raised when the selected backend cannot honour the request's metadata filters.

    Loud on purpose: a backend that drops filters it was handed answers a different question
    than the one asked, and the caller has no way to tell from the results.
    """


class SearchRequest(BaseModel):
    """Retrieve results from the collection globally, excluding exact canonical IDs."""

    query: str = Field(min_length=1, description="Natural-language search query.")
    collection_name: str = Field(default=_DEFAULT_COLLECTION, description="Vector-store collection to search.")
    top_k: int = Field(default=_DEFAULT_TOP_K, ge=1, le=100, description="Max results to return.")
    embed_model: str = Field(
        default=_DEPLOYMENT_EMBED_MODEL, description="Mistral embedding model for the query vector."
    )
    exclude_ids: list[str] = Field(
        default_factory=list,
        description="Exact canonical chunk IDs to exclude before top-k and reranking.",
    )
    filters: dict[str, str] = Field(default_factory=dict, description="Exact-match metadata filters.")
    hybrid: bool = Field(
        default=True,
        description=(
            "Fuse dense vector search with BM25 keyword search by reciprocal rank. On by default: "
            "dense retrieval alone misses rare exact terms. Set false for vector-only. Backends "
            "without BM25 support serve vector-only results either way."
        ),
    )
    rerank: bool = Field(default=False, description="If true, apply an LLM reranker to the results.")
    rerank_model: str = Field(default=_DEFAULT_RERANK_MODEL, description="Model used by the LLM reranker.")
    rerank_candidates: int | None = Field(
        default=None,
        ge=1,
        le=_MAX_RERANK_CANDIDATES,
        description=(
            "How many candidates to retrieve before reranking. Only read when `rerank` is true. "
            "None retrieves exactly `top_k`, which makes the reranker a reordering of the results "
            "that were already going to be returned. Set it above `top_k` to give the reranker a "
            "wider pool to cut down. Each extra candidate is one more LLM call, served serially by "
            "`LLMReRanker`, against the activity's 300s timeout."
        ),
    )

    @model_validator(mode="after")
    def _validate_rerank_candidates(self) -> Self:
        # Retrieving fewer rows than the caller asked to be returned under-delivers silently: the
        # reranker would slice a pool smaller than `top_k` and the result would look like a thin
        # corpus rather than a misconfigured request.
        if self.rerank and self.rerank_candidates is not None and self.rerank_candidates < self.top_k:
            raise ValueError(f"rerank_candidates ({self.rerank_candidates}) must be >= top_k ({self.top_k})")
        return self


class CorpusSearchResult(BaseModel):
    query: str
    collection_name: str
    groups: list[SourceGroup]
    atom_count: int
    group_count: int
    reranked: bool


class OpenRequest(BaseModel):
    """Resolve a chunk and return a local window around it (never excluded)."""

    anchor_id: str = Field(description="Canonical chunk ID to open.")
    collection_name: str = _DEFAULT_COLLECTION
    before: int = Field(default=_DEFAULT_WINDOW, ge=0, le=50, description="Chunks to include before the anchor.")
    after: int = Field(default=_DEFAULT_WINDOW, ge=0, le=50, description="Chunks to include after the anchor.")


class OpenResult(BaseModel):
    anchor_id: str
    collection_name: str
    group: SourceGroup | None = None
    failure: OperationFailure | None = None


NavigateDirection = Literal["next", "previous"]


class NavigateRequest(BaseModel):
    """Move relative to a known chunk within its source."""

    anchor_id: str = Field(description="Canonical chunk ID to navigate from.")
    collection_name: str = _DEFAULT_COLLECTION
    direction: NavigateDirection = Field(default="next", description="Traversal direction from the anchor.")
    count: int = Field(default=1, ge=1, le=50, description="Number of chunks to move/return.")


class NavigateResult(BaseModel):
    anchor_id: str
    collection_name: str
    direction: NavigateDirection
    group: SourceGroup | None = None
    failure: OperationFailure | None = None


class ReadRequest(BaseModel):
    """Read a known region of a source by character offsets or page range.

    Ranges may be one-sided (only a start or only an end). Providing neither an
    offset nor a page bound reads the whole source.
    """

    source_id: str = Field(description="Stable source identity to read from.")
    collection_name: str = _DEFAULT_COLLECTION
    start_offset: int | None = Field(default=None, ge=0, description="Inclusive start character offset.")
    end_offset: int | None = Field(default=None, ge=0, description="Exclusive end character offset.")
    start_page: int | None = Field(default=None, ge=1, description="Inclusive start page (1-based).")
    end_page: int | None = Field(default=None, ge=1, description="Inclusive end page (1-based).")

    @model_validator(mode="after")
    def _validate_region(self) -> Self:
        if self.start_offset is not None and self.end_offset is not None and self.end_offset < self.start_offset:
            raise ValueError("end_offset must be >= start_offset")
        if self.start_page is not None and self.end_page is not None and self.end_page < self.start_page:
            raise ValueError("end_page must be >= start_page")
        offset_region = self.start_offset is not None or self.end_offset is not None
        page_region = self.start_page is not None or self.end_page is not None
        if offset_region and page_region:
            raise ValueError("Provide either an offset region or a page region, not both")
        return self


class ReadResult(BaseModel):
    source_id: str
    collection_name: str
    group: SourceGroup | None = None
    failure: OperationFailure | None = None


GrepMode = Literal["term", "phrase"]


class GrepRequest(BaseModel):
    """Lexical source-local search (no corpus retrieval)."""

    source_id: str = Field(description="Stable source identity to search within.")
    collection_name: str = _DEFAULT_COLLECTION
    pattern: str = Field(min_length=1, description="Literal term or phrase to match.")
    mode: GrepMode = Field(default="term", description="'term' matches any token; 'phrase' matches the sequence.")
    top_k: int = Field(default=_DEFAULT_TOP_K, ge=1, le=100, description="Max matching chunks to return.")


class GrepResult(BaseModel):
    source_id: str
    collection_name: str
    pattern: str
    mode: GrepMode
    match_count: int = Field(description="Chunks matching the pattern; a floor when `count_truncated`.")
    count_truncated: bool = Field(
        default=False,
        description="True when the backend could only count up to a cap, so `match_count` understates the total.",
    )
    group: SourceGroup | None = None
    failure: OperationFailure | None = None


ReconcileAction = Literal["new", "updated", "deleted", "unchanged"]


class SourceSnapshotItem(BaseModel):
    source_key: str = Field(min_length=1, max_length=_MAX_BUSINESS_ID_LEN)
    size: int = 0
    etag: str | None = None
    mtime: datetime | None = None


class EnumerateRequest(BaseModel):
    prefix: str | None = None


class EnumerateResult(BaseModel):
    items: list[SourceSnapshotItem] = Field(default_factory=list)


class ReconcileItem(BaseModel):
    source_key: str
    action: ReconcileAction
    size: int = 0
    etag: str | None = None
    mtime: datetime | None = None


class ReconcilePlanRequest(BaseModel):
    collection_name: str = _DEFAULT_COLLECTION
    run_id: str
    snapshot: list[SourceSnapshotItem] = Field(default_factory=list)


class ReconcilePlan(BaseModel):
    collection_name: str
    run_id: str
    items: list[ReconcileItem] = Field(default_factory=list)
    snapshot_count: int = 0
    existing_count: int = 0
    deleted_count: int = 0


class EnsureCollectionRequest(BaseModel):
    collection_name: str = _DEFAULT_COLLECTION
    embed_model: str = _DEPLOYMENT_EMBED_MODEL


class RecordIngestedRequest(BaseModel):
    """Fingerprint one ingested batch in the manifest, minus the sources that failed.

    ``failed_source_keys`` is the batch workflow's failure list projected onto source keys; the
    plugin reports failures, so the sources to record are ``items`` less those.
    """

    collection_name: str = _DEFAULT_COLLECTION
    run_id: str
    items: list[ReconcileItem] = Field(default_factory=list)
    failed_source_keys: list[str] = Field(default_factory=list)


class RecordIngestedResult(BaseModel):
    created: int = 0
    updated: int = 0
    failed: int = 0


class DeleteRequest(BaseModel):
    collection_name: str = _DEFAULT_COLLECTION
    source_keys: list[str] = Field(default_factory=list)
    run_id: str = ""


class DeleteResult(BaseModel):
    collection_name: str
    deleted: int = 0
    failed: int = 0


class TombstoneGcRequest(BaseModel):
    collection_name: str = _DEFAULT_COLLECTION
    older_than_days: int = 30


class TombstoneGcResult(BaseModel):
    purged: int = 0


class ReindexAnnRequest(BaseModel):
    """Rebuild the approximate-nearest-neighbour index after a write pass."""

    collection_name: str = _DEFAULT_COLLECTION


class ReindexAnnResult(BaseModel):
    reindexed: bool = Field(default=False, description="False when the deployment has no ANN index to rebuild.")
    reason: str = ""


class ReconcileRequest(BaseModel):
    """Trigger a reconcile pass over the configured object-storage source."""

    collection_name: str = Field(default=_DEFAULT_COLLECTION, description="Target vector-store collection.")
    embed_model: str = Field(default=_DEPLOYMENT_EMBED_MODEL, description="Mistral embedding model.")
    prefix: str | None = Field(default=None, description="Object-key prefix to enumerate; null uses the env default.")
    dry_run: bool = Field(default=False, description="Plan and report without writing or deleting.")


class ReconcileResult(BaseModel):
    """Outcome of one reconcile pass: per-class counts plus abort status."""

    run_id: str
    created: int = 0
    updated: int = 0
    deleted: int = 0
    skipped: int = 0
    failed: int = 0
    dry_run: bool = False
    aborted: bool = False
    reason: str | None = None


class ReconcileSettings(BaseModel):
    delete_threshold: float
    batch_size: int
    # How many batch child workflows the sweep keeps in flight. Also the manifest's write
    # granularity: a wave is recorded once every child in it has returned.
    max_concurrent_batches: int
    tombstone_gc_days: int
    dry_run: bool
