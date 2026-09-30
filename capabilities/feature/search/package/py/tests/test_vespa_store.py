"""Vespa adapter unit tests over a fake index.

The shared contract suite is parametrized over the local and postgres backends only -- Vespa
needs a live server -- so the two pieces of adapter-owned logic that are not the plugin's have
no coverage there: the windowed `read_pages` pagination and the empty-vs-unknown source rule
that `read`/`read_pages` layer over a document-per-chunk index. Both are exercised here against
an in-memory fake that reproduces the plugin's `read` semantics (chunks with
``start_offset >= start``, ordered by ``start_offset``, capped at ``top_k``; unknown source
raises ``SourceNotFoundError``).
"""

import pytest
from mistralai.search.toolkit.document import ChunkType
from mistralai.search.toolkit.search.errors import SourceNotFoundError
from mistralai.search.toolkit.search.models import SearchResult, SearchResultChunk

from mistralai_capabilities.search import vespa_store


def _result(chunk_id: str, start: int, end: int, page: int) -> SearchResult:
    chunk = SearchResultChunk(
        id=chunk_id,
        source_id="d1",
        locator=f"loc-{chunk_id}",
        start_offset=start,
        end_offset=end,
        chunk_type=ChunkType.CONTENT,
        parent_ref="parent",
        content=chunk_id,
        metadata={"page_number": str(page)},
    )
    return SearchResult(chunk=chunk, score=0.0, distance=None)


class _FakeIndex:
    """Mimics VespaStoreIndex.read: start_offset lower bound, ordered, top_k-capped."""

    def __init__(self, chunks_by_source: dict[str, list[SearchResult]]) -> None:
        self._data = chunks_by_source

    async def read(
        self, source_id, start_offset, end_offset, *, content_type, top_k, context
    ) -> list[SearchResult]:
        if source_id not in self._data:
            raise SourceNotFoundError(source_id)
        low = start_offset or 0
        rows = [row for row in self._data[source_id] if row.chunk.start_offset >= low]
        return rows[:top_k]


def _adapter(chunks_by_source: dict[str, list[SearchResult]], known: set[str], monkeypatch):
    # Small window so multi-window pagination is exercised without thousands of rows.
    monkeypatch.setattr(vespa_store.env, "search_max_atoms_per_source", 2, raising=False)
    adapter = vespa_store.VespaSearchAdapter("collection", _FakeIndex(chunks_by_source))

    async def _source_known(source_id: str) -> bool:
        return source_id in known

    monkeypatch.setattr(adapter, "_source_known", _source_known)
    return adapter


async def test_read_pages_keeps_overlapping_chunks_across_windows(monkeypatch):
    # c2 is nested inside c1's character span; ordered by start_offset the sequence is c1, c2, c3.
    # Advancing the cursor to the greatest end_offset (100) after the first window [c1, c2] would
    # skip c3 (start 30 < 100); resuming at the last row's start_offset does not.
    source = [_result("c1", 0, 100, 1), _result("c2", 10, 20, 2), _result("c3", 30, 40, 3)]
    adapter = _adapter({"d1": source}, {"d1"}, monkeypatch)

    pages = await adapter.read_pages("d1", None, None, top_k=50)

    assert [item.chunk.id for item in pages] == ["c1", "c2", "c3"]


async def test_read_pages_returns_empty_for_a_page_range_with_no_chunks(monkeypatch):
    source = [_result("c1", 0, 10, 1)]
    adapter = _adapter({"d1": source}, {"d1"}, monkeypatch)

    assert await adapter.read_pages("d1", 5, 9, top_k=50) == []


async def test_read_pages_returns_empty_for_an_indexed_but_chunkless_source(monkeypatch):
    adapter = _adapter({"empty": []}, {"empty"}, monkeypatch)

    assert await adapter.read_pages("empty", None, None, top_k=50) == []


async def test_read_pages_raises_for_an_unknown_source(monkeypatch):
    adapter = _adapter({"d1": [_result("c1", 0, 10, 1)]}, {"d1"}, monkeypatch)

    with pytest.raises(SourceNotFoundError):
        await adapter.read_pages("never-seen", None, None, top_k=50)


async def test_read_returns_empty_for_an_indexed_but_chunkless_source(monkeypatch):
    adapter = _adapter({"empty": []}, {"empty"}, monkeypatch)

    assert await adapter.read("empty", 0, None, top_k=50) == []


async def test_read_raises_for_an_unknown_source(monkeypatch):
    adapter = _adapter({"d1": [_result("c1", 0, 10, 1)]}, {"d1"}, monkeypatch)

    with pytest.raises(SourceNotFoundError):
        await adapter.read("never-seen", 0, None, top_k=50)
