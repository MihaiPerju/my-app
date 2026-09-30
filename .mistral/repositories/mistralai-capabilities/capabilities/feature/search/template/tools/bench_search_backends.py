"""Measure diskann vs sequential scan and BM25 recall through the real ``PostgresSearchStore``.

Seeding is slow because diskann rebuilds its graph on every insert. Drop
``ix_search_atoms_diskann`` before a bulk load and rebuild it after.

Usage:
    DATABASE_URL=postgresql+asyncpg://... uv run --no-sync python tools/bench_search_backends.py [rows]
"""

import asyncio
import math
import random
import statistics
import sys
import time

from db import dispose_engine, get_engine, get_session_maker
from db.models.search import EMBEDDING_DIM
from mistralai.search.toolkit.document import (
    Document,
    DocumentFileMetadata,
    PagedDocumentChunk,
    PagedDocumentChunkMetadata,
    compute_id,
    compute_page_locator,
)
from mistralai_capabilities.search.postgres_store import (
    _probe_capabilities,
    get_postgres_store,
    reset_capability_cache,
)
from mistralai_capabilities.search.schemas import CollectionConfig, FilteredVectorSearchQuery
from sqlalchemy import text
from sqlmodel import SQLModel

_DISKANN_INDEX = "ix_search_atoms_diskann"
_COLLECTION = "bench_timescaledb"
_RARE_TERM = "xylophonic"
_VOCABULARY = (
    "regulatory compliance framework audit obligation disclosure governance risk "
    "control procedure retention oversight mandate directive statute provision"
).split()


def _structured_embedding(index: int) -> list[float]:
    """A dense vector with genuine low-dimensional structure, indexed by row.

    A smooth function of the row index gives each vector distinct nearest neighbours, so the index
    result is comparable to the exact scan. A bag-of-words hash collides into ties, and i.i.d.
    random high-dimensional vectors concentrate, so both make the recall measurement meaningless.
    """
    return [math.sin(index * 0.0173 + s * 0.911) * math.cos(index * 0.0071 * s) for s in range(1, EMBEDDING_DIM + 1)]


def _near(index: int, jitter: float = 0.01) -> list[float]:
    """A query vector close to a known row, so an exact top-k genuinely exists."""
    return [value + random.gauss(0.0, jitter) for value in _structured_embedding(index)]


def _document(source_id: str, chunks: list[tuple[str, list[float]]]) -> Document:
    parent_ref = compute_id(source_id)
    docs: list[PagedDocumentChunk] = []
    offset = 0
    for page, (content, embedding) in enumerate(chunks, start=1):
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
                embedding=embedding,
            )
        )
        offset = end + 1
    return Document(
        source_id=source_id,
        content="\n".join(content for content, _ in chunks),
        chunks=docs,
        metadata=DocumentFileMetadata(filename=f"{source_id}.txt", filepath=f"{source_id}.txt", url=None, title=None),
    )


async def _time_searches(store, queries: list[FilteredVectorSearchQuery]) -> list[float]:
    timings = []
    for query in queries:
        started = time.perf_counter()
        await store.search(query)
        timings.append((time.perf_counter() - started) * 1000)
    return timings


async def _explain(query: FilteredVectorSearchQuery) -> str:
    vector = "[" + ",".join(str(value) for value in query.embedding) + "]"
    session_maker = get_session_maker()
    async with session_maker() as session:
        rows = await session.execute(
            text(
                "EXPLAIN SELECT atom_id FROM search_atoms WHERE collection_name = :c "
                f"ORDER BY embedding <=> '{vector}'::vector LIMIT 10"
            ),
            {"c": _COLLECTION},
        )
        return "\n".join(row[0] for row in rows)


async def main() -> None:
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    chunks_per_source = 50
    random.seed(7)

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    reset_capability_cache()
    capabilities = await _probe_capabilities()
    print(f"capabilities: {capabilities}")  # noqa: T201

    store = get_postgres_store(_COLLECTION)
    session_maker = get_session_maker()
    async with session_maker() as session, session.begin():
        await session.execute(text("DELETE FROM search_atoms WHERE collection_name = :c"), {"c": _COLLECTION})
        await session.execute(text("DELETE FROM search_sources WHERE collection_name = :c"), {"c": _COLLECTION})
        await session.execute(text("DELETE FROM search_collections WHERE collection_name = :c"), {"c": _COLLECTION})
    await store.ensure_collection(CollectionConfig(collection_name=_COLLECTION, embed_dim=EMBEDDING_DIM))

    print(f"seeding {rows} atoms ...")  # noqa: T201
    seeded = 0
    source_index = 0
    while seeded < rows:
        batch = min(chunks_per_source, rows - seeded)
        chunks = [
            (
                f"atom{seeded + offset} " + " ".join(random.choices(_VOCABULARY, k=12)),
                _structured_embedding(seeded + offset),
            )
            for offset in range(batch)
        ]
        if source_index == 0:
            # The rare term sits on an ordinary vector, so nothing about its
            # embedding makes it findable. Only the lexical arm can surface it —
            # which is the whole point of adding BM25.
            chunks[0] = (
                f"atom0 the term {_RARE_TERM} appears exactly once in this entire corpus",
                _structured_embedding(0),
            )
        await store.index_document(_document(f"bench-src-{source_index}", chunks))
        seeded += batch
        source_index += 1
    async with session_maker() as session, session.begin():
        await session.execute(text("ANALYZE search_atoms"))

    queries = [
        FilteredVectorSearchQuery(embedding=_near(random.randrange(rows)), top_k=10, exclude_ids=set())
        for _ in range(20)
    ]

    print("\n--- WITH diskann (TimescaleDB + pgvectorscale) ---")  # noqa: T201
    print(await _explain(queries[0]))  # noqa: T201
    with_index = await _time_searches(store, queries)
    print(f"p50={statistics.median(with_index):.2f}ms  mean={statistics.fmean(with_index):.2f}ms")  # noqa: T201
    indexed_ids = [result.chunk.id for result in await store.search(queries[0])]

    async with session_maker() as session, session.begin():
        await session.execute(text(f"DROP INDEX IF EXISTS {_DISKANN_INDEX}"))
    print("\n--- WITHOUT diskann (exact sequential scan: the previous behaviour) ---")  # noqa: T201
    print(await _explain(queries[0]))  # noqa: T201
    without_index = await _time_searches(store, queries)
    print(f"p50={statistics.median(without_index):.2f}ms  mean={statistics.fmean(without_index):.2f}ms")  # noqa: T201
    exact_ids = [result.chunk.id for result in await store.search(queries[0])]

    overlap = len(set(indexed_ids) & set(exact_ids)) / max(len(exact_ids), 1)
    speedup = statistics.median(without_index) / max(statistics.median(with_index), 1e-9)
    print(f"\nrecall@10 of diskann vs exact: {overlap:.2%}")  # noqa: T201
    print(f"median speedup: {speedup:.1f}x")  # noqa: T201

    async with session_maker() as session, session.begin():
        await session.execute(
            text(
                f"CREATE INDEX IF NOT EXISTS {_DISKANN_INDEX} "
                "ON search_atoms USING diskann (embedding vector_cosine_ops)"
            )
        )

    if capabilities["bm25"]:
        print("\n--- rare-term retrieval: dense-only vs hybrid ---")  # noqa: T201
        # Query vector points at an unrelated part of the corpus: the rare term is
        # reachable only lexically.
        rare = FilteredVectorSearchQuery(embedding=_near(rows // 2), query=_RARE_TERM, top_k=10, exclude_ids=set())
        dense = [result.chunk.content for result in await store.search(rare)]
        hybrid = [result.chunk.content for result in await store.hybrid_search(rare)]
        print(f"dense-only  found the rare term: {any(_RARE_TERM in c for c in dense)}")  # noqa: T201
        print(f"hybrid      found the rare term: {any(_RARE_TERM in c for c in hybrid)}")  # noqa: T201

    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
