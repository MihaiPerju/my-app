import pytest
from mistralai.search.toolkit.document import ChunkType, compute_char_locator, compute_id, compute_page_locator
from mistralai.search.toolkit.search.models import SearchResult, SearchResultChunk
from pydantic import ValidationError
from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    GrepRequest,
    NavigateRequest,
    OpenRequest,
    ReadRequest,
    SearchRequest,
    SourceMeta,
    group_results,
)


def _result(source_id: str, start: int, end: int, page: int | None = None, content: str = "x") -> SearchResult:
    locator = compute_page_locator(page, start, end) if page is not None else compute_char_locator(start, end)
    chunk = SearchResultChunk(
        source_id=source_id,
        locator=locator,
        start_offset=start,
        end_offset=end,
        chunk_type=ChunkType.CONTENT,
        parent_ref=compute_id(source_id),
        content=content,
        metadata={"page_number": str(page)} if page is not None else {},
    )
    return SearchResult(chunk=chunk, score=0.0, distance=None)


def test_chunk_id_is_deterministic_from_source_and_locator() -> None:
    locator = compute_char_locator(0, 10)
    chunk = SearchResultChunk(
        source_id="d1",
        locator=locator,
        start_offset=0,
        end_offset=10,
        chunk_type=ChunkType.CONTENT,
        content="hello",
    )
    assert chunk.id == compute_id("d1", locator)
    assert compute_id("d1", locator) != compute_id("d1", compute_char_locator(0, 11))


def test_page_locator_encodes_page_and_offsets() -> None:
    assert compute_char_locator(0, 10) == "char:0-10"
    assert compute_page_locator(3, 5, 20) == "page:3:char:5-20"


def test_search_request_defaults_exclude_ids_empty() -> None:
    req = SearchRequest.model_validate({"query": "q"})
    assert req.exclude_ids == []
    assert req.top_k == 5


def test_search_defaults_to_hybrid_retrieval() -> None:
    """Dense-only misses rare exact terms, so BM25 fusion is the default, not an opt-in."""
    assert SearchRequest.model_validate({"query": "q"}).hybrid is True
    assert SearchRequest.model_validate({"query": "q", "hybrid": False}).hybrid is False


def test_search_request_rejects_empty_query_and_bad_top_k() -> None:
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({"query": ""})
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({"query": "q", "top_k": 0})


def test_rerank_candidates_defaults_to_none_so_the_two_k_stay_equal() -> None:
    """Unset, retrieval fetches exactly top_k: no existing caller's LLM bill moves."""
    assert SearchRequest.model_validate({"query": "q"}).rerank_candidates is None


def test_rerank_candidates_may_not_undercut_top_k_when_reranking() -> None:
    """A pool smaller than top_k under-delivers, and reads as a thin corpus rather than a bad request."""
    reranking = {"query": "q", "rerank": True, "top_k": 5}
    assert SearchRequest.model_validate({**reranking, "rerank_candidates": 5}).rerank_candidates == 5
    assert SearchRequest.model_validate({**reranking, "rerank_candidates": 50}).rerank_candidates == 50
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({**reranking, "rerank_candidates": 4})


def test_rerank_candidates_below_top_k_is_accepted_when_not_reranking() -> None:
    """Inert without `rerank`, like `rerank_model`: a value this request never reads cannot reject it."""
    request = SearchRequest.model_validate({"query": "q", "top_k": 10, "rerank": False, "rerank_candidates": 5})
    assert request.rerank_candidates == 5


def test_rerank_candidates_is_bounded() -> None:
    """Each candidate costs one serially awaited LLM call, so the ceiling bounds latency."""
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({"query": "q", "rerank_candidates": 0})
    with pytest.raises(ValidationError):
        SearchRequest.model_validate({"query": "q", "rerank_candidates": 101})


def test_open_navigate_grep_validation() -> None:
    OpenRequest.model_validate({"anchor_id": "a", "before": 0, "after": 2})
    NavigateRequest.model_validate({"anchor_id": "a", "direction": "previous", "count": 3})
    with pytest.raises(ValidationError):
        NavigateRequest.model_validate({"anchor_id": "a", "direction": "sideways"})
    with pytest.raises(ValidationError):
        GrepRequest.model_validate({"source_id": "s", "pattern": ""})


def test_read_request_region_rules() -> None:
    ReadRequest.model_validate({"source_id": "s", "start_offset": 10})
    ReadRequest.model_validate({"source_id": "s", "end_offset": 10})
    ReadRequest.model_validate({"source_id": "s", "start_page": 2, "end_page": 4})
    with pytest.raises(ValidationError):
        ReadRequest.model_validate({"source_id": "s", "start_offset": 10, "end_offset": 5})
    with pytest.raises(ValidationError):
        ReadRequest.model_validate({"source_id": "s", "start_offset": 0, "start_page": 1})


def test_group_results_preserves_order_and_factors_source_metadata() -> None:
    results = [_result("d1", 0, 5), _result("d2", 0, 5), _result("d1", 6, 10)]
    meta = {"d1": SourceMeta(source_id="d1", filename="a.txt", title="A")}
    groups = group_results(results, meta)
    assert [g.source_id for g in groups] == ["d1", "d2"]
    assert groups[0].filename == "a.txt"
    assert len(groups[0].results) == 2
    assert groups[1].filename is None


def test_collection_config_defaults() -> None:
    cfg = CollectionConfig(collection_name="c")
    assert cfg.embed_dim == 128
    assert cfg.chunking_version == "atoms-1"
