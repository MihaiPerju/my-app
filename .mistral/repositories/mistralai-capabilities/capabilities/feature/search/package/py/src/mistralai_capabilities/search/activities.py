"""Agentic Search retrieval activities: corpus search + source-local navigation.

Activities are the only layer that calls the Mistral SDK and the store. Corpus ``search`` applies
``exclude_ids`` and carries scores; source-local ``open``/``navigate``/``read``/``grep`` are
unranked. This layer is read-only; writes live in :mod:`.reconcile`. Each activity stacks
``@agents.tool`` over ``@workflows.activity``. The request parameter is named ``args`` because the
Agents SDK requires that name.
"""

from datetime import timedelta
from typing import TYPE_CHECKING

import mistralai.workflows as workflows
from env.mistral import env as mistral_env
from env.search import env
from env.workflows import env as workflows_env
from mistralai.agents import agents
from mistralai.client import Mistral
from mistralai.search.toolkit.search.errors import SourceNotFoundError
from mistralai.search.toolkit.search.index import GrepMode as SdkGrepMode
from mistralai.search.toolkit.search.index import NavigationDirection
from mistralai.search.toolkit.search.models import SearchResult
from mistralai.workflows import Depends
from mistralai_capabilities.search.schemas import (
    _DEFAULT_COLLECTION as _DEPLOYMENT_COLLECTION,
)
from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    CorpusSearchResult,
    FilteredVectorSearchQuery,
    GrepRequest,
    GrepResult,
    NavigateRequest,
    NavigateResult,
    OpenRequest,
    OpenResult,
    OperationFailure,
    ReadRequest,
    ReadResult,
    SearchRequest,
    SourceGroup,
    group_results,
)
from mistralai_capabilities.search.store import GrepOutcome, SearchStore

if TYPE_CHECKING:
    from mistralai.search.toolkit.embedders import MistralEmbedder


def _mistral_client() -> Mistral:
    return Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)


_MODEL_DIMS = {"mistral-embed": 1024, "mistral-embed-dim256-2510": 256, "mistral-embed-dim128-2510": 128}


class SearchBackendUnavailableError(RuntimeError):
    """Raised when no concrete store backend is configured."""


class UnknownEmbeddingModelError(RuntimeError):
    """Raised when an embedding model has no known vector dimension."""


class UnknownCollectionError(RuntimeError):
    """Raised when a request names a collection this deployment does not provision."""


def _open_store(collection_name: str) -> SearchStore:
    # One deployment provisions one collection. `collection_name` reaches here from request
    # bodies and from an agent's tool arguments, and on the plugin backends opening a collection
    # can create a table and its indexes -- so an unbounded set of names is an unbounded set of
    # schema objects. The provisioned name is the migration's; anything else is refused here
    # rather than quietly conjured.
    if collection_name != _DEPLOYMENT_COLLECTION:
        raise UnknownCollectionError(
            f"This deployment serves collection {_DEPLOYMENT_COLLECTION!r}; request asked for {collection_name!r}"
        )
    backend = env.search_backend
    if backend == "local":
        from mistralai_capabilities.search.local_store import get_local_store

        return get_local_store(collection_name)
    if backend == "postgres":
        from mistralai_capabilities.search.postgres_store import get_postgres_store

        return get_postgres_store(collection_name)
    if backend == "vespa":
        from mistralai_capabilities.search.vespa_store import get_vespa_store

        return get_vespa_store(collection_name)
    raise SearchBackendUnavailableError(f"Unknown search backend {backend!r}")


def _build_embedder(client: Mistral, embed_model: str) -> "MistralEmbedder":
    from mistralai.search.toolkit.embedders import MistralEmbedder

    return MistralEmbedder(client, model_name=embed_model)


def _infer_dim(embed_model: str) -> int:
    try:
        return _MODEL_DIMS[embed_model]
    except KeyError as error:
        raise UnknownEmbeddingModelError(
            f"Unknown embedding model {embed_model!r}; expected one of {sorted(_MODEL_DIMS)}"
        ) from error


async def _group(store: SearchStore, results: list[SearchResult]) -> list[SourceGroup]:
    source_ids = list(dict.fromkeys(result.chunk.source_id for result in results))
    metas = await store.source_metas(source_ids)
    return group_results(results, metas)


async def _first_group(store: SearchStore, results: list[SearchResult]) -> SourceGroup | None:
    groups = await _group(store, results)
    return groups[0] if groups else None


def _not_found_failure(message: str) -> OperationFailure:
    return OperationFailure(kind="not_found", message=message)


async def _run_search(request: SearchRequest, client: Mistral) -> CorpusSearchResult:
    store = _open_store(request.collection_name)
    await store.ensure_collection(
        CollectionConfig(
            collection_name=request.collection_name,
            embed_model=request.embed_model,
            embed_dim=_infer_dim(request.embed_model),
        )
    )
    embedder = _build_embedder(client, request.embed_model)
    query_vector = await embedder.embed_query(request.query)
    retrieval_top_k = request.rerank_candidates if (request.rerank and request.rerank_candidates) else request.top_k
    # The toggle is the query TEXT, not a separate method. No backend defines `hybrid_search`
    # any more: the postgres plugin fuses BM25 with the dense score whenever `query.query` is
    # non-empty and returns its dense statement when it is blank, and Vespa's `hybrid-search`
    # profile has nothing lexical to match on without it. `LocalSearchStore` is dense-only and
    # ignores the field. So blanking the text is what "hybrid off" means on every backend, and
    # feature-detecting a method that no longer exists would silently leave fusion on.
    query = FilteredVectorSearchQuery(
        embedding=query_vector,
        query=request.query if request.hybrid else "",
        top_k=retrieval_top_k,
        exclude_ids=set(request.exclude_ids),
        filters=request.filters,
    )
    results = await store.search(query)
    reranked = False
    if request.rerank and results:
        results = await _rerank(client, request.rerank_model, request.query, results, request.top_k)
        reranked = True
    results = results[: request.top_k]
    groups = await _group(store, results)
    return CorpusSearchResult(
        query=request.query,
        collection_name=request.collection_name,
        groups=groups,
        atom_count=len(results),
        group_count=len(groups),
        reranked=reranked,
    )


async def _rerank(
    client: Mistral, rerank_model: str, query: str, results: list[SearchResult], top_k: int
) -> list[SearchResult]:
    from mistralai.search.toolkit.llm import LLMConfig, MistralChat
    from mistralai.search.toolkit.retrieval.rerankers import LLMReRanker

    reranker = LLMReRanker(MistralChat(client, config=LLMConfig(model=rerank_model)), top_k=top_k)
    ranked = await reranker.rerank(query, results)
    order = {item.chunk.id: index for index, item in enumerate(ranked)}
    return sorted(results, key=lambda item: order.get(item.chunk.id, len(results)))[:top_k]


@agents.tool(
    name="search_search",
    description="Search the corpus for atoms matching a query, grouped by source.",
    input_schema=SearchRequest,
    model_access="direct",
)
@workflows.activity(
    name="search_search",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_search(args: SearchRequest, client: Mistral = Depends(_mistral_client)) -> CorpusSearchResult:
    return await _run_search(args, client)


@agents.tool(
    name="search_open",
    description="Open a window of neighbouring atoms around an anchor atom within its source.",
    input_schema=OpenRequest,
    model_access="direct",
)
@workflows.activity(
    name="search_open",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_open(args: OpenRequest) -> OpenResult:
    store = _open_store(args.collection_name)
    anchor = await store.get_chunk(args.anchor_id)
    if anchor is None:
        return OpenResult(
            anchor_id=args.anchor_id,
            collection_name=args.collection_name,
            failure=_not_found_failure(f"Unknown anchor chunk {args.anchor_id!r}"),
        )
    source_id = anchor.chunk.source_id
    start = anchor.chunk.start_offset or 0
    end = anchor.chunk.end_offset or 0
    try:
        before = await store.navigate(source_id, start, end, NavigationDirection.PREVIOUS, top_k=args.before)
        after = await store.navigate(source_id, start, end, NavigationDirection.NEXT, top_k=args.after)
    except SourceNotFoundError as error:
        return OpenResult(
            anchor_id=args.anchor_id,
            collection_name=args.collection_name,
            failure=_not_found_failure(str(error)),
        )
    window = [*before, anchor, *after]
    return OpenResult(
        anchor_id=args.anchor_id,
        collection_name=args.collection_name,
        group=await _first_group(store, window),
    )


@agents.tool(
    name="search_navigate",
    description="Move to the next or previous atoms from an anchor atom within its source.",
    input_schema=NavigateRequest,
    model_access="direct",
)
@workflows.activity(
    name="search_navigate",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_navigate(args: NavigateRequest) -> NavigateResult:
    store = _open_store(args.collection_name)
    anchor = await store.get_chunk(args.anchor_id)
    if anchor is None:
        return NavigateResult(
            anchor_id=args.anchor_id,
            collection_name=args.collection_name,
            direction=args.direction,
            failure=_not_found_failure(f"Unknown anchor chunk {args.anchor_id!r}"),
        )
    direction = NavigationDirection.NEXT if args.direction == "next" else NavigationDirection.PREVIOUS
    try:
        moved = await store.navigate(
            anchor.chunk.source_id,
            anchor.chunk.start_offset or 0,
            anchor.chunk.end_offset or 0,
            direction,
            top_k=args.count,
        )
    except SourceNotFoundError as error:
        return NavigateResult(
            anchor_id=args.anchor_id,
            collection_name=args.collection_name,
            direction=args.direction,
            failure=_not_found_failure(str(error)),
        )
    return NavigateResult(
        anchor_id=args.anchor_id,
        collection_name=args.collection_name,
        direction=args.direction,
        group=await _first_group(store, moved),
    )


@agents.tool(
    name="search_read",
    description="Read a known region of a source by character offsets or page range.",
    input_schema=ReadRequest,
    model_access="direct",
)
@workflows.activity(
    name="search_read",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_read(args: ReadRequest) -> ReadResult:
    store = _open_store(args.collection_name)
    # Bound reads by the per-source atom cap so a whole-source read returns the entire region
    # rather than silently truncating at the SDK's default top_k of 20.
    read_limit = env.search_max_atoms_per_source
    try:
        if args.start_page is not None or args.end_page is not None:
            results = await store.read_pages(args.source_id, args.start_page, args.end_page, top_k=read_limit)
        else:
            results = await store.read(args.source_id, args.start_offset, args.end_offset, top_k=read_limit)
    except SourceNotFoundError as error:
        return ReadResult(
            source_id=args.source_id,
            collection_name=args.collection_name,
            failure=_not_found_failure(str(error)),
        )
    return ReadResult(
        source_id=args.source_id,
        collection_name=args.collection_name,
        group=await _first_group(store, results),
    )


@agents.tool(
    name="search_grep",
    description="Count and locate a literal term or phrase inside a single source.",
    input_schema=GrepRequest,
    model_access="direct",
)
@workflows.activity(
    name="search_grep",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_grep(args: GrepRequest) -> GrepResult:
    store = _open_store(args.collection_name)
    mode = SdkGrepMode.PHRASE if args.mode == "phrase" else SdkGrepMode.TERM
    try:
        outcome: GrepOutcome = await store.grep_count(args.source_id, args.pattern, mode=mode, top_k=args.top_k)
    except SourceNotFoundError as error:
        return GrepResult(
            source_id=args.source_id,
            collection_name=args.collection_name,
            pattern=args.pattern,
            mode=args.mode,
            match_count=0,
            failure=_not_found_failure(str(error)),
        )
    return GrepResult(
        source_id=args.source_id,
        collection_name=args.collection_name,
        pattern=args.pattern,
        mode=args.mode,
        match_count=outcome.total,
        count_truncated=outcome.truncated,
        group=await _first_group(store, outcome.matches),
    )
