"""Postgres-specific search tests.

Hybrid (BM25 + vector) search has been dropped from the pgvector backend; use the Vespa
plugin for hybrid search. The remaining tests cover dense-only invariants and
ensure_collection validation that are not exercised by the shared contract suite.
"""

import hashlib
import uuid

import pytest
from mistralai.search.toolkit.document import (
    Document,
    DocumentFileMetadata,
    PagedDocumentChunk,
    PagedDocumentChunkMetadata,
    compute_id,
    compute_page_locator,
)
from search_pg_support import DIM, pg_contract_enabled
from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    CollectionConfigMismatchError,
    FilteredVectorSearchQuery,
)

pytestmark = pytest.mark.skipif(not pg_contract_enabled, reason="RUN_PG_CONTRACT is not set")


def _embed(text: str) -> list[float]:
    vec = [0.0] * DIM
    for token in text.lower().split():
        vec[int(hashlib.md5(token.encode(), usedforsecurity=False).hexdigest(), 16) % DIM] += 1.0
    return vec


def _build(source_id: str, chunks: list[str]) -> Document:
    parent_ref = compute_id(source_id)
    docs: list[PagedDocumentChunk] = []
    offset = 0
    for page, content in enumerate(chunks, start=1):
        start, end = offset, offset + len(content)
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
        offset = end + 1
    return Document(
        source_id=source_id,
        content="\n".join(chunks),
        chunks=docs,
        metadata=DocumentFileMetadata(filename="doc.txt", filepath="doc.txt", url=None, title=None),
    )


@pytest.fixture
async def store_factory():
    from db import dispose_engine, get_engine
    from mistralai_capabilities.search.postgres_store import get_postgres_store
    from sqlalchemy import text
    from sqlmodel import SQLModel

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(SQLModel.metadata.create_all)
    try:
        yield get_postgres_store
    finally:
        await dispose_engine()


async def _seeded(store_factory, chunks: list[str]):
    store = store_factory(f"h_{uuid.uuid4().hex[:12]}")
    await store.ensure_collection(CollectionConfig(collection_name=store.collection_name, embed_dim=DIM))
    await store.index_document(_build("src-1", chunks))
    return store


async def test_vector_search_still_reports_distance_and_the_score_invariant(store_factory):
    store = await _seeded(store_factory, ["regulatory compliance framework", "unrelated filler text"])

    results = await store.search(
        FilteredVectorSearchQuery(
            embedding=_embed("regulatory compliance"), top_k=2, exclude_ids=set()
        )
    )

    assert results
    for result in results:
        assert result.distance is not None
        assert result.score == pytest.approx(1.0 - result.distance)


async def test_ensure_collection_rejects_a_dimension_the_column_cannot_store(store_factory):
    store = store_factory(f"h_{uuid.uuid4().hex[:12]}")

    with pytest.raises(CollectionConfigMismatchError):
        await store.ensure_collection(CollectionConfig(collection_name=store.collection_name, embed_dim=DIM + 1))
