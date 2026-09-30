"""Feature-scoped tests for search (mocked; no network required)."""

import hashlib
from collections.abc import Awaitable, Callable
from typing import Any

import mistralai_capabilities.search.activities as activities
import pytest
from mistralai.search.toolkit.document import (
    Document,
    DocumentFileMetadata,
    PagedDocumentChunk,
    PagedDocumentChunkMetadata,
    compute_id,
    compute_page_locator,
)
from mistralai.vibe.sdk.capabilities import authoring as vibe_tool_definition
from mistralai.vibe.sdk.capabilities.adapters.local_function import _import_dotted_path
from mistralai.workflows import get_workflow_definition
from mistralai.workflows.core.discovery import discover_workflows_in_module
from mistralai_capabilities.search.activities import (
    search_grep,
    search_navigate,
    search_open,
    search_read,
    search_search,
)
from mistralai_capabilities.search.local_store import reset_local_stores
from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    CorpusSearchResult,
    GrepRequest,
    NavigateRequest,
    OpenRequest,
    ReadRequest,
    ReconcileRequest,
    SearchRequest,
)
from pydantic import ValidationError
from worker.workflows.tooling import create_workflow_tools

_DIM = 16
_EMBED_MODEL = "mistral-embed-dim128-2510"


class _EmbedResult:
    def __init__(self, embeddings: list[list[float]]) -> None:
        self.embeddings = embeddings
        self.total_tokens = 0


def _vec(text: str) -> list[float]:
    vec = [0.0] * _DIM
    for token in text.lower().split():
        vec[int(hashlib.md5(token.encode(), usedforsecurity=False).hexdigest(), 16) % _DIM] += 1.0
    return vec


class _FakeEmbedder:
    async def embed(self, texts: list[str], context: Any = None) -> _EmbedResult:
        return _EmbedResult([_vec(text) for text in texts])

    async def embed_query(self, query: str, context: Any = None) -> list[float]:
        return _vec(query)


def _activity(tool_or_activity: Any) -> Any:
    return (
        tool_or_activity.handler
        if isinstance(tool_or_activity, vibe_tool_definition.ToolDefinition)
        else tool_or_activity
    )


def _raw(tool_or_activity: Any) -> Callable[..., Awaitable[Any]]:
    fn = _activity(tool_or_activity)
    while hasattr(fn, "__wrapped__"):
        fn = fn.__wrapped__
    return fn


def _document(source_id: str, chunks: list[str]) -> Document:
    parent_ref = compute_id(source_id)
    paged: list[PagedDocumentChunk] = []
    offset = 0
    for content in chunks:
        start, end = offset, offset + len(content)
        paged.append(
            PagedDocumentChunk(
                source_id=source_id,
                locator=compute_page_locator(1, start, end),
                start_offset=start,
                end_offset=end,
                parent_ref=parent_ref,
                content=content,
                metadata=PagedDocumentChunkMetadata(page_number=1),
                embedding=_vec(content),
            )
        )
        offset = end + 1
    return Document(
        source_id=source_id,
        content="\n".join(chunks),
        chunks=paged,
        metadata=DocumentFileMetadata(filename="doc.txt", filepath="doc.txt"),
    )


async def _seed(collection: str, source_id: str, chunks: list[str]) -> None:
    store = activities._open_store(collection)
    await store.ensure_collection(
        CollectionConfig(
            collection_name=collection,
            embed_model=_EMBED_MODEL,
            embed_dim=activities._infer_dim(_EMBED_MODEL),
        )
    )
    await store.index_document(_document(source_id, chunks))


def test_every_search_tool_can_be_imported_back_from_its_own_transport_address() -> None:
    """The agent reaches these by import path, and nothing else in the suite exercises it.

    `@workflows.activity(name=...)` assigns that name to `__name__`, and `@agents.tool` builds
    the tool's address as `f"{__module__}.{__name__}.invoke"`. Resolving it walks the module
    with `getattr`, so it holds only while the activity name equals the attribute the tool is
    bound to. A mismatch raises `AttributeError` the first time the agent calls the tool. Other
    tests miss this because they invoke `.handler(...)` directly and never touch the address.
    """
    for tool in (search_search, search_open, search_navigate, search_read, search_grep):
        assert tool.fn_path.endswith(".invoke")
        assert _import_dotted_path(tool.fn_path.removesuffix(".invoke")) is tool


def test_activities_registered() -> None:
    expected = {
        search_search: "search_search",
        search_open: "search_open",
        search_navigate: "search_navigate",
        search_read: "search_read",
        search_grep: "search_grep",
    }
    for tool_or_activity, activity_name in expected.items():
        assert _activity(tool_or_activity).__temporal_activity_definition.name == activity_name


def test_retrieval_activities_are_also_agent_tools() -> None:
    expected = {
        search_search: SearchRequest,
        search_open: OpenRequest,
        search_navigate: NavigateRequest,
        search_read: ReadRequest,
        search_grep: GrepRequest,
    }
    for tool, request_model in expected.items():
        assert isinstance(tool, vibe_tool_definition.ToolDefinition)
        assert tool.input_schema is request_model
        assert tool.description != tool.name
        assert tool.model_access == "direct"


def test_search_tools_reach_the_orchestrator_one_file_each() -> None:
    """The Unified Harness has no subagents: each of search's five retrieval tools is its own module
    under `worker/agents/tools/` exposing `tool`, which `mistralai_capabilities.agents.assembly` merges
    into the agent."""
    import importlib

    names = ["search_search", "search_open", "search_navigate", "search_read", "search_grep"]
    tools = [importlib.import_module(f"worker.agents.tools.{name}").tool for name in names]
    assert [tool.name for tool in tools] == names
    # Every contributed tool must be model-callable (direct) on the Unified Harness.
    for tool in tools:
        assert isinstance(tool, vibe_tool_definition.ToolDefinition)
        assert tool.model_access == "direct"
    # The TOOLs are the activity tools themselves, not re-wrapped copies.
    assert tools == [search_search, search_open, search_navigate, search_read, search_grep]


def test_search_reconcile_workflow_has_stable_name_and_tool_schema() -> None:
    """The sweep and both plugin workflows must be discoverable from this module.

    ``IngestDocumentsWorkflow`` and ``IngestBatchWorkflow`` are imported by `workflows/search.py`
    purely so worker discovery — which walks module members — registers them. The plugin ships no
    registration hook, so dropping either import would leave a child no worker can pick up, and
    nothing else would notice: the sweep names only the first, which starts the second itself.
    """
    import worker.workflows.search as search_module

    workflow_classes = discover_workflows_in_module("worker.workflows.search")
    assert {get_workflow_definition(cls).name for cls in workflow_classes} == {
        "search_reconcile",
        "search-ingest-documents",
        "search-ingest-batch",
    }

    tools = {tool.name: tool for tool in create_workflow_tools(workflow_classes)}
    assert tools["search_reconcile"].input_schema is ReconcileRequest
    assert search_module.search_reconcile_tool.name == "search_reconcile"


def test_search_schema_rejects_bad_top_k_and_empty_query() -> None:
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({"query": "q", "top_k": 0})
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({"query": ""})


@pytest.fixture
def _local_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(activities, "_build_embedder", lambda _client, _model: _FakeEmbedder())
    monkeypatch.setattr(activities.env, "search_backend", "local")
    reset_local_stores()


@pytest.mark.asyncio
async def test_full_agentic_loop_local_backend(_local_backend: None) -> None:
    first_request = SearchRequest(query="beta four five", top_k=2)
    collection = first_request.collection_name
    await _seed(
        collection,
        "d1",
        ["alpha one two three.", "beta four five six.", "gamma seven eight nine.", "delta ten eleven twelve."],
    )

    first = await _raw(search_search)(
        first_request,
        client=object(),
    )
    assert isinstance(first, CorpusSearchResult)
    assert first.atom_count >= 1
    anchor = first.groups[0].results[0].chunk

    excluded = await _raw(search_search)(
        SearchRequest(collection_name=collection, query="beta four five", top_k=5, exclude_ids=[anchor.id]),
        client=object(),
    )
    assert anchor.id not in [item.chunk.id for group in excluded.groups for item in group.results]

    opened = await _raw(search_open)(OpenRequest(collection_name=collection, anchor_id=anchor.id, before=1, after=1))
    assert opened.failure is None
    assert opened.group is not None
    assert anchor.id in [item.chunk.id for item in opened.group.results]

    navigated = await _raw(search_navigate)(
        NavigateRequest(collection_name=collection, anchor_id=anchor.id, direction="next", count=1)
    )
    assert navigated.failure is None

    read = await _raw(search_read)(ReadRequest(collection_name=collection, source_id="d1", start_offset=0))
    assert read.failure is None
    assert read.group is not None

    grep = await _raw(search_grep)(
        GrepRequest(collection_name=collection, source_id="d1", pattern="gamma", mode="term")
    )
    assert grep.failure is None
    assert grep.match_count >= 1


@pytest.mark.asyncio
async def test_read_unknown_source_returns_structured_failure(_local_backend: None) -> None:
    request = ReadRequest(source_id="missing", start_offset=0)
    await _seed(request.collection_name, "d1", ["hello world"])

    result = await _raw(search_read)(request)
    assert result.group is None
    assert result.failure is not None
    assert result.failure.kind == "not_found"


@pytest.mark.asyncio
async def test_rerank_candidates_widen_retrieval_without_widening_the_answer(
    _local_backend: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reranker handed exactly `top_k` rows can only reorder them; `_run_search` is what feeds it.

    The spy replaces `_rerank` so no LLM is called, and records how many candidates reached it --
    the only observable that distinguishes a widened retrieval from the old behaviour, since both
    return `top_k` results either way.
    """
    seen: list[int] = []

    async def _spy(_client: Any, _model: str, _query: str, results: list[Any], top_k: int) -> list[Any]:
        seen.append(len(results))
        return results[:top_k]

    monkeypatch.setattr(activities, "_rerank", _spy)

    collection = SearchRequest(query="seed").collection_name
    await _seed(collection, "d1", [f"chunk {index} alpha beta" for index in range(8)])

    widened = await _raw(search_search)(
        SearchRequest(query="alpha beta", top_k=2, rerank=True, rerank_candidates=6), client=object()
    )
    assert seen == [6], "retrieval should fetch rerank_candidates, not top_k"
    assert widened.atom_count == 2, "the answer is still top_k"
    assert widened.reranked is True

    seen.clear()
    unset = await _raw(search_search)(SearchRequest(query="alpha beta", top_k=2, rerank=True), client=object())
    assert seen == [2], "unset means the two k stay equal, as before this field existed"
    assert unset.atom_count == 2

    seen.clear()
    reranking_off = await _raw(search_search)(
        SearchRequest(query="alpha beta", top_k=2, rerank=False, rerank_candidates=6), client=object()
    )
    assert seen == [], "no reranker ran"
    assert reranking_off.atom_count == 2, "so nothing was over-fetched to feed it"
    assert reranking_off.reranked is False
