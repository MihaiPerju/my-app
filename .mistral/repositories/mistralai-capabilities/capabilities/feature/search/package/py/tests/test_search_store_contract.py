import hashlib
import os
import uuid
from collections.abc import Callable

import pytest
from mistralai.search.toolkit.document import (
    Document,
    DocumentFileMetadata,
    PagedDocumentChunk,
    PagedDocumentChunkMetadata,
    compute_id,
    compute_page_locator,
)
from mistralai.search.toolkit.search.errors import SourceNotFoundError
from mistralai.search.toolkit.search.index import GrepMode, NavigableIndex, NavigationDirection, StoreIndex
from search_pg_support import DIM
from mistralai_capabilities.search.local_store import get_local_store, reset_local_stores
from mistralai_capabilities.search.schemas import (
    _DEPLOYMENT_EMBED_MODEL,
    CollectionConfig,
    CollectionConfigMismatchError,
    FilteredVectorSearchQuery,
)
from mistralai_capabilities.search.store import GrepOutcome

# Tied to db.models.search.EMBEDDING_DIM: the postgres backend stores vectors in a
# physically typed vector(N) column so it can carry an ANN index, so an off-dimension
# fixture would be rejected before it could exercise anything.
_DIM = DIM

_BACKENDS = ["local"]
if os.getenv("RUN_PG_CONTRACT"):
    _BACKENDS.append("postgres")


def _embed(text: str) -> list[float]:
    vec = [0.0] * _DIM
    for token in text.lower().split():
        index = int(hashlib.md5(token.encode(), usedforsecurity=False).hexdigest(), 16) % _DIM
        vec[index] += 1.0
    return vec


def _query(text: str, *, top_k: int, exclude_ids: set[str] | None = None) -> FilteredVectorSearchQuery:
    return FilteredVectorSearchQuery(embedding=_embed(text), top_k=top_k, exclude_ids=exclude_ids or set())


def _build(
    source_id: str,
    chunks: list[tuple[str, int]],
    *,
    filename: str | None = None,
    url: str | None = None,
    title: str | None = None,
) -> Document:
    parent_ref = compute_id(source_id)
    docs: list[PagedDocumentChunk] = []
    offset = 0
    parts: list[str] = []
    for content, page in chunks:
        start = offset
        end = offset + len(content)
        docs.append(
            PagedDocumentChunk(
                source_id=source_id,
                locator=compute_page_locator(page, start, end),
                start_offset=start,
                end_offset=end,
                parent_ref=parent_ref,
                content=content,
                metadata=PagedDocumentChunkMetadata(page_number=page),
                embedding=_embed(content),
            )
        )
        parts.append(content)
        offset = end + 1
    return Document(
        source_id=source_id,
        content="\n".join(parts),
        chunks=docs,
        metadata=DocumentFileMetadata(
            filename=filename or "doc.txt",
            filepath=url or filename or "doc.txt",
            url=url,
            title=title,
        ),
    )


@pytest.fixture(params=_BACKENDS)
async def make_store(request: pytest.FixtureRequest):
    if request.param == "local":
        reset_local_stores()
        yield get_local_store
        return

    from db import dispose_engine, get_engine
    from mistralai_capabilities.search.postgres_store import get_postgres_store
    from sqlalchemy import text
    from sqlmodel import SQLModel

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.run_sync(SQLModel.metadata.create_all)
    try:
        yield get_postgres_store
    finally:
        await dispose_engine()


def _new_collection() -> str:
    """A unique collection whose derived identifiers still fit Postgres's 63-byte limit.

    The plugin appends `_chunks` and then per-index suffixes, the longest being
    `_chunks_document_id_len` (23 bytes) and `_chunks_hnsw_m16_efc64_hv_cos` (29). It rejects
    anything over 63 rather than letting Postgres truncate into a collision, so a full uuid4 hex
    here (`contract_` + 32 = 41) overflows by one byte and every postgres-backed test errors
    before it starts. 12 hex chars keep the worst case at 46 and stay collision-free per run.
    """
    return f"c_{uuid.uuid4().hex[:12]}"


async def _seed(store, doc: Document) -> None:
    await store.ensure_collection(CollectionConfig(collection_name=store.collection_name, embed_dim=_DIM))
    await store.index_document(doc)


async def test_store_satisfies_sdk_protocols(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    # The postgres adapter wraps a plugin index; the local store implements these directly.
    sdk_index = getattr(store, "_index", store)
    assert isinstance(sdk_index, StoreIndex)
    assert isinstance(sdk_index, NavigableIndex)


async def test_ingest_produces_multiple_ordered_chunks(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("alpha one", 1), ("beta two", 1), ("gamma three", 2)]))
    with pytest.raises(SourceNotFoundError):
        await store.read("_none_", None, None)
    full = await store.read("d1", None, None)
    assert [item.chunk.content for item in full] == ["alpha one", "beta two", "gamma three"]


async def test_reingest_replaces_source_idempotently(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("alpha one", 1), ("beta two", 1)]))
    await store.index_document(_build("d1", [("alpha one", 1), ("beta two", 1)]))
    full = await store.read("d1", None, None)
    assert len(full) == 2


async def test_second_search_excludes_all_previously_seen(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("alpha one", 1), ("beta two", 1), ("gamma three", 1)]))
    first = await store.search(_query("alpha beta gamma", top_k=3))
    seen = {item.chunk.id for item in first}
    assert seen
    second = await store.search(_query("alpha beta gamma", top_k=3, exclude_ids=seen))
    assert not any(item.chunk.id in seen for item in second)


async def test_excluded_chunk_remains_navigable(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("alpha", 1), ("beta", 1), ("gamma", 1)]))
    hits = await store.search(_query("alpha", top_k=1))
    anchor = hits[0].chunk
    again = await store.search(_query("alpha", top_k=3, exclude_ids={anchor.id}))
    assert anchor.id not in {item.chunk.id for item in again}
    fetched = await store.get_chunk(anchor.id)
    assert fetched is not None


async def test_navigation_respects_boundaries_and_order(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("a", 1), ("b", 1), ("c", 1)]))
    ordered = await store.read("d1", None, None)
    first, _, last = [item.chunk for item in ordered]
    nxt = await store.navigate("d1", first.start_offset or 0, first.end_offset or 0, NavigationDirection.NEXT, top_k=2)
    assert [item.chunk.content for item in nxt] == ["b", "c"]
    prev = await store.navigate(
        "d1", last.start_offset or 0, last.end_offset or 0, NavigationDirection.PREVIOUS, top_k=5
    )
    assert [item.chunk.content for item in prev] == ["a", "b"]
    beyond = await store.navigate("d1", last.start_offset or 0, last.end_offset or 0, NavigationDirection.NEXT, top_k=3)
    assert beyond == []


async def test_read_is_fully_contained(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("first", 1), ("second", 2), ("third", 3)]))
    ordered = [item.chunk for item in await store.read("d1", None, None)]
    second = ordered[1]
    contained = await store.read("d1", second.start_offset, second.end_offset)
    assert [item.chunk.content for item in contained] == ["second"]
    partial = await store.read("d1", second.start_offset, (second.end_offset or 0) - 1)
    assert partial == []
    from_second = await store.read("d1", second.start_offset, None)
    assert [item.chunk.content for item in from_second] == ["second", "third"]


async def test_read_pages_selects_page_range(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("first", 1), ("second", 2), ("third", 3)]))
    page = await store.read_pages("d1", 2, 2)
    assert [item.chunk.content for item in page] == ["second"]
    one_sided = await store.read_pages("d1", 2, None)
    assert [item.chunk.content for item in one_sided] == ["second", "third"]


async def test_grep_phrase_vs_term(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    chunks = [("capital requirements are high", 1), ("requirements without the capital word", 1)]
    await _seed(store, _build("d1", chunks))
    phrase = await store.grep_count("d1", "capital requirements", mode=GrepMode.PHRASE)
    assert isinstance(phrase, GrepOutcome)
    assert phrase.total == 1
    term = await store.grep_count("d1", "capital requirements", mode=GrepMode.TERM)
    assert isinstance(term, GrepOutcome)
    assert term.total == 2


async def test_grep_count_is_total_not_top_k(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("match here", 1), ("match again", 1), ("match once more", 1)]))
    outcome = await store.grep_count("d1", "match", mode=GrepMode.TERM, top_k=1)
    assert outcome.total == 3
    assert len(outcome.matches) == 1


async def test_unknown_source_vs_empty_region(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("only", 1)]))
    empty = await store.read_pages("d1", 5, 9)
    assert empty == []
    with pytest.raises(SourceNotFoundError):
        await store.read_pages("does-not-exist", 5, 9)


async def test_get_chunk_resolves_and_misses(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("hello", 1)]))
    chunk_id = compute_id("d1", compute_page_locator(1, 0, len("hello")))
    fetched = await store.get_chunk(chunk_id)
    assert fetched is not None
    assert fetched.chunk.content == "hello"
    assert await store.get_chunk("missing") is None


async def test_collection_config_cannot_drift(make_store: Callable[[str], object]) -> None:
    """Neither the model nor its width may change under an existing collection.

    The baseline uses the deployment's own model because that is what the remote backends accept:
    `search_collections` no longer records which model wrote the vectors, so they treat
    `INGESTION_EMBED_MODEL` as the collection's identity. `LocalSearchStore` keeps the config it
    was given and compares against that. Different mechanisms, one contract -- which is the point
    of asserting it here, over every backend, rather than in a postgres-only test.
    """
    collection = _new_collection()
    store = make_store(collection)
    await store.ensure_collection(
        CollectionConfig(collection_name=collection, embed_model=_DEPLOYMENT_EMBED_MODEL, embed_dim=_DIM)
    )
    with pytest.raises(CollectionConfigMismatchError):
        # Same width, different model: the vectors would be a different geometry of the same
        # arity, which no dimension check can catch.
        await store.ensure_collection(
            CollectionConfig(collection_name=collection, embed_model="mistral-embed-other", embed_dim=_DIM)
        )
    with pytest.raises(CollectionConfigMismatchError):
        # Dim change is the universally detectable drift signal across all backends.
        await store.ensure_collection(
            CollectionConfig(collection_name=collection, embed_model=_DEPLOYMENT_EMBED_MODEL, embed_dim=_DIM + 1)
        )


async def test_delete_document_uses_sdk_document_id(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("gone", 1)]))
    # SDK contract: delete by the document id (compute_id(source_id)); the raw source id is a no-op.
    await store.delete_document("d1")
    assert isinstance(await store.read("d1", None, None), list)
    await store.delete_document(compute_id("d1"))
    with pytest.raises(SourceNotFoundError):
        await store.read("d1", None, None)


async def test_delete_empty_document_by_doc_id(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    empty = Document(
        source_id="empty",
        content="",
        chunks=[],
        metadata=DocumentFileMetadata(filename="e.txt", filepath="e.txt"),
    )
    await _seed(store, empty)
    assert isinstance(await store.read("empty", None, None), list)
    await store.delete_document(compute_id("empty"))
    with pytest.raises(SourceNotFoundError):
        await store.read("empty", None, None)


async def test_navigate_with_zero_top_k_returns_empty(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("a", 1), ("b", 1), ("c", 1)]))
    chunks = [item.chunk for item in await store.read("d1", None, None)]
    anchor = chunks[1]
    for direction in (NavigationDirection.NEXT, NavigationDirection.PREVIOUS):
        moved = await store.navigate("d1", anchor.start_offset or 0, anchor.end_offset or 0, direction, top_k=0)
        assert moved == []


async def test_search_honors_inclusion_flags(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [("alpha beta", 1)], filename="f.txt"))
    query = FilteredVectorSearchQuery(
        embedding=_embed("alpha beta"), top_k=5, include_content=False, include_metadata=False
    )
    results = await store.search(query)
    assert results
    assert all(item.chunk.content == "" for item in results)
    assert all(item.chunk.metadata == {} for item in results)


async def test_whole_source_read_is_not_truncated_at_twenty(make_store: Callable[[str], object]) -> None:
    store = make_store(_new_collection())
    await _seed(store, _build("d1", [(f"chunk number {i}", 1) for i in range(25)]))
    whole = await store.read("d1", None, None, top_k=1000)
    assert len(whole) == 25


async def test_summary_chunk_type_is_navigable_in_both_backends(make_store: Callable[[str], object]) -> None:
    from mistralai.search.toolkit.document import ChunkType

    store = make_store(_new_collection())
    source_id = "d1"
    parent_ref = compute_id(source_id)
    doc = Document(
        source_id=source_id,
        content="intro body summary",
        chunks=[
            PagedDocumentChunk(
                source_id=source_id,
                locator=compute_page_locator(1, 0, 5),
                start_offset=0,
                end_offset=5,
                parent_ref=parent_ref,
                content="intro",
                chunk_type=ChunkType.CONTENT,
                metadata=PagedDocumentChunkMetadata(page_number=1),
                embedding=_embed("intro"),
            ),
            PagedDocumentChunk(
                source_id=source_id,
                locator=compute_page_locator(1, 6, 13, ChunkType.SUMMARY),
                start_offset=6,
                end_offset=13,
                parent_ref=parent_ref,
                content="summary",
                chunk_type=ChunkType.SUMMARY,
                metadata=PagedDocumentChunkMetadata(page_number=1),
                embedding=_embed("summary"),
            ),
        ],
        metadata=DocumentFileMetadata(filename="f.txt", filepath="f.txt"),
    )
    await _seed(store, doc)
    summaries = await store.read("d1", None, None, content_type=ChunkType.SUMMARY)
    assert [item.chunk.content for item in summaries] == ["summary"]


async def test_source_title_falls_back_to_the_markdown_h1(make_store: Callable[[str], object]) -> None:
    # A markdown corpus carries no extractor title, so every source used to surface `title=None`.
    store = make_store(_new_collection())
    await _seed(store, _build("gdpr/article-033.md", [("# Article 33 — Breach notification", 1), ("body", 1)]))
    await _seed(store, _build("titled.md", [("# Heading", 1)], title="Extractor title"))
    metas = await store.source_metas(["gdpr/article-033.md", "titled.md"])
    assert metas["gdpr/article-033.md"].title == "Article 33 — Breach notification"
    assert metas["titled.md"].title == "Extractor title"
