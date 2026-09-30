"""Feature-local store scaffolding for Agentic Search.

Both backends subclass the SDK ``StoreIndex`` and satisfy the SDK ``NavigableIndex`` protocol,
plus feature extensions the protocol does not cover (``ensure_collection``, ``get_chunk``,
``source_metas``, ``read_pages``). The helpers below are pure functions over one source's ordered
results, so the in-memory backend matches the PostgreSQL backend exactly.
"""

import math
import re
from dataclasses import dataclass, field
from typing import Protocol

from db import get_session_maker
from db.models.search import SearchSource
from mistralai.search.toolkit.document import ChunkType, Document, DocumentChunk, compute_id
from mistralai.search.toolkit.search.index import GrepMode, NavigationDirection
from mistralai.search.toolkit.search.models import SearchResult, SearchResultChunk
from sqlmodel import col, delete, select

from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    FilteredVectorSearchQuery,
    SourceMeta,
)

# Keys promoted to first-class SourceMeta fields (or pipeline internals): kept out of the extra bag.
_RESERVED_SOURCE_META_KEYS = frozenset({"filename", "filepath", "url", "title", "extractor_type", "pipeline_version"})

# `search_sources.title` is VARCHAR(1024).
_MAX_TITLE_LEN = 1024
_TITLE_SCAN_CHARS = 4096
_FRONT_MATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
_FRONT_MATTER_TITLE = re.compile(r"^title[ \t]*:[ \t]*(.+?)[ \t]*$", re.MULTILINE)
# An ATX level-1 heading: one `#`, then text, with any closing `#`s dropped.
_FIRST_H1 = re.compile(r"^[ ]{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$", re.MULTILINE)


@dataclass
class GrepOutcome:
    matches: list[SearchResult]
    total: int
    # Set when the backend could only count up to a cap, so `total` is a floor rather than the
    # answer. Postgres counts with SQL and never sets it; Vespa's plugin exposes no count query,
    # so it counts by fetching and has a ceiling.
    truncated: bool = False


class SearchStore(Protocol):
    """Feature-local store contract that every backend satisfies structurally.

    It covers the SDK ``StoreIndex``/``NavigableIndex`` surface plus feature extensions
    (``ensure_collection``, ``get_chunk``, ``source_metas``, ``read_pages``, ``grep_count``).
    """

    async def ensure_collection(self, config: CollectionConfig) -> CollectionConfig: ...
    async def index_document(self, document: Document) -> None: ...
    async def delete_document(self, doc_id: str) -> None: ...
    async def search(self, query: FilteredVectorSearchQuery) -> list[SearchResult]: ...
    async def get_chunk(self, chunk_id: str) -> SearchResult | None: ...
    async def navigate(
        self, source_id: str, start_offset: int, end_offset: int, direction: NavigationDirection, *, top_k: int = 1
    ) -> list[SearchResult]: ...
    async def read(
        self, source_id: str, start_offset: int | None, end_offset: int | None, *, top_k: int = 20
    ) -> list[SearchResult]: ...
    async def read_pages(
        self, source_id: str, start_page: int | None, end_page: int | None, *, top_k: int = 20
    ) -> list[SearchResult]: ...
    async def grep_count(
        self, source_id: str, pattern: str, *, mode: GrepMode = GrepMode.PHRASE, top_k: int = 5
    ) -> GrepOutcome: ...
    async def source_metas(self, source_ids: list[str]) -> dict[str, SourceMeta]: ...


def resolve_doc_id(document: Document) -> str:
    """Canonical document-id key shared by every backend's index/delete path."""
    return document.id or compute_id(document.source_id)


def derive_title(content: str) -> str | None:
    """A display title read off the document text: front-matter ``title:``, else the first ``# H1``.

    Extractors fill ``metadata.title`` only for formats that carry one (HTML ``<title>``, PDF info),
    so a markdown or plain-text corpus used to ingest with ``title=None`` on every source and the UI
    fell back to filenames. Only the head of the text is read: a title is at the top or nowhere, and
    a heading deep in a long document is a section, not the document's name.
    """
    head = content.removeprefix("\ufeff")[:_TITLE_SCAN_CHARS]
    front = _FRONT_MATTER.match(head)
    if front is not None:
        title = _FRONT_MATTER_TITLE.search(front.group(1))
        if title is not None:
            return _clean_title(title.group(1))
        head = head[front.end() :]
    heading = _FIRST_H1.search(head)
    return _clean_title(heading.group(1)) if heading is not None else None


def _clean_title(raw: str) -> str | None:
    title = raw.strip().strip("\"'").strip()
    return title[:_MAX_TITLE_LEN] or None


def source_meta(document: Document) -> SourceMeta:
    """Canonical Document -> SourceMeta projection (every backend).

    The title prefers the extractor's metadata and falls back to :func:`derive_title`.
    """
    metadata = document.metadata
    extra = {
        key: str(value)
        for key, value in metadata.model_dump().items()
        if key not in _RESERVED_SOURCE_META_KEYS and value is not None
    }
    return SourceMeta(
        source_id=document.source_id,
        filename=metadata.get("filename"),
        url=metadata.get("url"),
        title=metadata.get("title") or derive_title(document.content or ""),
        metadata=extra,
    )


class SourceMetadataStore:
    """The ``search_sources`` half of a remote-index backend, owned in one place.

    Both the Postgres and Vespa adapters keep display metadata in ``search_sources`` while their
    index holds the chunks, and the bookkeeping either side of that split is identical: record a
    source on index, forget it on delete, resolve a ``doc_id`` back to its ``source_id``, and
    answer ``source_metas``. Held here rather than copied into each adapter because the copies had
    already drifted -- a chunkless document and a zero-``top_k`` navigate behaved differently per
    backend before this, which is a difference callers cannot see coming.

    Subclasses own only what is genuinely index-specific.
    """

    collection_name: str

    async def _record_source(self, document: Document) -> None:
        """Upsert the source row that ``source_metas`` reads and ``read`` uses to prove existence."""
        meta = source_meta(document)
        session_maker = get_session_maker()
        async with session_maker() as session, session.begin():
            await session.merge(
                SearchSource(
                    collection_name=self.collection_name,
                    source_id=document.source_id,
                    doc_id=resolve_doc_id(document),
                    content=document.content,
                    filename=meta.filename,
                    url=meta.url,
                    title=meta.title,
                    mime_type=None,
                    source_metadata=dict(meta.metadata),
                    extraction_version=str(document.metadata.get("extraction_version") or "1.0.0"),
                    checksum=str(document.metadata.get("checksum") or ""),
                    page_count=int(document.metadata.get("total_pages") or document.metadata.get("page_count") or 0),
                )
            )

    async def _source_id_for_doc(self, doc_id: str) -> str | None:
        session_maker = get_session_maker()
        async with session_maker() as session:
            return (
                await session.execute(
                    select(col(SearchSource.source_id))
                    .where(
                        col(SearchSource.collection_name) == self.collection_name,
                        col(SearchSource.doc_id) == doc_id,
                    )
                    .limit(1)
                )
            ).scalars().first()

    async def _forget_source(self, source_id: str) -> None:
        session_maker = get_session_maker()
        async with session_maker() as session, session.begin():
            await session.execute(
                delete(SearchSource).where(
                    col(SearchSource.collection_name) == self.collection_name,
                    col(SearchSource.source_id) == source_id,
                )
            )

    async def _source_known(self, source_id: str) -> bool:
        """Whether the source was ever indexed, which the chunk table alone cannot answer.

        A document indexed with no chunks leaves nothing in the index, so the index reports it as
        unknown; this row is what separates "indexed but empty" from "never seen".
        """
        session_maker = get_session_maker()
        async with session_maker() as session:
            found = (
                await session.execute(
                    select(col(SearchSource.source_id))
                    .where(
                        col(SearchSource.collection_name) == self.collection_name,
                        col(SearchSource.source_id) == source_id,
                    )
                    .limit(1)
                )
            ).scalars().first()
        return found is not None

    async def source_metas(self, source_ids: list[str]) -> dict[str, SourceMeta]:
        if not source_ids:
            return {}
        session_maker = get_session_maker()
        async with session_maker() as session:
            rows = (
                await session.execute(
                    select(SearchSource).where(
                        col(SearchSource.collection_name) == self.collection_name,
                        col(SearchSource.source_id).in_(source_ids),
                    )
                )
            ).scalars().all()
        return {
            row.source_id: SourceMeta(
                source_id=row.source_id,
                filename=row.filename,
                url=row.url,
                title=row.title,
                metadata={str(k): str(v) for k, v in (row.source_metadata or {}).items()},
            )
            for row in rows
        }


@dataclass
class Collection:
    config: CollectionConfig
    sources: dict[str, SourceMeta] = field(default_factory=dict)
    content: dict[str, str] = field(default_factory=dict)
    chunks_by_source: dict[str, list[DocumentChunk]] = field(default_factory=dict)
    chunk_index: dict[str, str] = field(default_factory=dict)
    source_by_doc_id: dict[str, str] = field(default_factory=dict)


def chunk_metadata(chunk: DocumentChunk) -> dict[str, str]:
    return {key: str(value) for key, value in chunk.metadata.model_dump().items() if value is not None}


def chunk_to_result_chunk(chunk: DocumentChunk, metadata: dict[str, str] | None = None) -> SearchResultChunk:
    return SearchResultChunk(
        id=chunk.id,
        source_id=chunk.source_id,
        locator=chunk.locator,
        start_offset=chunk.start_offset,
        end_offset=chunk.end_offset,
        chunk_type=chunk.chunk_type,
        parent_ref=chunk.parent_ref,
        content=chunk.content,
        metadata=metadata if metadata is not None else chunk_metadata(chunk),
    )


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _sort_key(chunk: DocumentChunk) -> tuple[int, int]:
    return (chunk.start_offset, chunk.end_offset)


def order_chunks(chunks: list[DocumentChunk]) -> list[DocumentChunk]:
    return sorted(chunks, key=_sort_key)


def unranked(chunk: SearchResultChunk) -> SearchResult:
    return SearchResult(chunk=chunk, score=0.0, distance=None)


def scored(chunk: SearchResultChunk, score: float) -> SearchResult:
    return SearchResult(chunk=chunk, score=score, distance=1.0 - score)


def apply_inclusion(result: SearchResult, *, include_content: bool, include_metadata: bool) -> SearchResult:
    if include_content and include_metadata:
        return result
    chunk_updates: dict[str, object] = {}
    if not include_content:
        chunk_updates["content"] = ""
    if not include_metadata:
        chunk_updates["metadata"] = {}
    return result.model_copy(update={"chunk": result.chunk.model_copy(update=chunk_updates)})


def chunk_page(chunk: DocumentChunk) -> int | None:
    value = chunk.metadata.get("page_number")
    return int(value) if value is not None else None


def navigate_offsets(
    ordered: list[DocumentChunk],
    start_offset: int,
    end_offset: int,
    direction: NavigationDirection,
    top_k: int,
    content_type: ChunkType,
) -> list[DocumentChunk]:
    if top_k <= 0:
        return []
    typed = [chunk for chunk in ordered if chunk.chunk_type == content_type]
    if direction == NavigationDirection.NEXT:
        return [chunk for chunk in typed if chunk.start_offset >= end_offset][:top_k]
    backward = [chunk for chunk in typed if chunk.end_offset <= start_offset]
    return backward[-top_k:]


def read_offsets(
    ordered: list[DocumentChunk],
    start_offset: int | None,
    end_offset: int | None,
    content_type: ChunkType,
    top_k: int,
) -> list[DocumentChunk]:
    low = start_offset if start_offset is not None else 0
    contained = [
        chunk
        for chunk in ordered
        if chunk.chunk_type == content_type
        and chunk.start_offset >= low
        and (end_offset is None or chunk.end_offset <= end_offset)
    ]
    return contained[:top_k]


def page_in_range(page: int | None, start_page: int | None, end_page: int | None) -> bool:
    """Shared page-bounds predicate (default lower bound page 1; null pages excluded)."""
    if page is None:
        return False
    low = start_page if start_page is not None else 1
    return page >= low and (end_page is None or page <= end_page)


def read_page_range(
    ordered: list[DocumentChunk],
    start_page: int | None,
    end_page: int | None,
    content_type: ChunkType,
    top_k: int,
) -> list[DocumentChunk]:
    selected = [
        chunk
        for chunk in ordered
        if chunk.chunk_type == content_type and page_in_range(chunk_page(chunk), start_page, end_page)
    ]
    return selected[:top_k]


def matches_pattern(content: str, pattern: str, mode: GrepMode) -> bool:
    haystack = content.lower()
    needle = pattern.lower()
    if mode == GrepMode.PHRASE:
        return needle in haystack
    terms = [re.compile(rf"\b{re.escape(term)}\b") for term in needle.split() if term]
    return bool(terms) and all(term.search(haystack) for term in terms)


def grep_chunks(
    ordered: list[DocumentChunk], pattern: str, mode: GrepMode, content_type: ChunkType
) -> list[DocumentChunk]:
    return [
        chunk for chunk in ordered if chunk.chunk_type == content_type and matches_pattern(chunk.content, pattern, mode)
    ]
