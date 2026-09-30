"""In-memory backend for deterministic development and tests.

Subclasses the SDK ``StoreIndex[FilteredVectorSearchQuery]`` and satisfies the SDK
``NavigableIndex`` protocol. Stores are process-level singletons keyed by collection name.
Corpus search runs cosine similarity in Python; source-local navigation reuses the shared
pure functions in ``store.py``, so behavior matches the PostgreSQL backend exactly.
"""

from mistralai.search.toolkit.context import IngestContext, RetrievalContext
from mistralai.search.toolkit.document import ChunkType, Document, DocumentChunk
from mistralai.search.toolkit.search.errors import SourceNotFoundError
from mistralai.search.toolkit.search.index import GrepMode, NavigationDirection, StoreIndex
from mistralai.search.toolkit.search.models import SearchResult

from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    CollectionConfigMismatchError,
    FilteredVectorSearchQuery,
    SourceMeta,
)
from mistralai_capabilities.search.store import (
    Collection,
    GrepOutcome,
    apply_inclusion,
    chunk_to_result_chunk,
    cosine,
    grep_chunks,
    navigate_offsets,
    order_chunks,
    read_offsets,
    read_page_range,
    resolve_doc_id,
    scored,
    source_meta,
    unranked,
)


class LocalSearchStore(StoreIndex[FilteredVectorSearchQuery]):
    def __init__(self, collection_name: str) -> None:
        self.collection_name = collection_name

    def _collection(self) -> Collection | None:
        return _STORES.get(self.collection_name)

    async def ensure_collection(self, config: CollectionConfig) -> CollectionConfig:
        existing = _STORES.get(self.collection_name)
        if existing is None:
            _STORES[self.collection_name] = Collection(config=config)
            return config
        stored = existing.config
        if stored.embed_model != config.embed_model or stored.embed_dim != config.embed_dim:
            raise CollectionConfigMismatchError(
                f"Collection {self.collection_name!r} uses {stored.embed_model} (dim {stored.embed_dim}); "
                f"request asked for {config.embed_model} (dim {config.embed_dim})"
            )
        return stored

    async def index_document(self, document: Document, context: IngestContext = IngestContext()) -> None:
        collection = _STORES.setdefault(
            self.collection_name, Collection(config=CollectionConfig(collection_name=self.collection_name))
        )
        source_id = document.source_id
        for old in collection.chunks_by_source.get(source_id, []):
            collection.chunk_index.pop(old.id, None)
        ordered = order_chunks(list(document.chunks))
        collection.sources[source_id] = source_meta(document)
        collection.content[source_id] = document.content
        collection.chunks_by_source[source_id] = ordered
        collection.source_by_doc_id[resolve_doc_id(document)] = source_id
        for chunk in ordered:
            collection.chunk_index[chunk.id] = source_id

    async def delete_document(self, doc_id: str, context: IngestContext = IngestContext()) -> None:
        collection = self._collection()
        if collection is None:
            return
        source_id = collection.source_by_doc_id.pop(doc_id, None)
        if source_id is None:
            return
        for chunk in collection.chunks_by_source.pop(source_id, []):
            collection.chunk_index.pop(chunk.id, None)
        collection.sources.pop(source_id, None)
        collection.content.pop(source_id, None)

    async def search(
        self, query: FilteredVectorSearchQuery, context: RetrievalContext = RetrievalContext()
    ) -> list[SearchResult]:
        collection = self._collection()
        if collection is None:
            return []
        results: list[SearchResult] = []
        for chunks in collection.chunks_by_source.values():
            for chunk in chunks:
                if chunk.id in query.exclude_ids:
                    continue
                metadata = chunk_to_result_chunk(chunk).metadata
                if query.filters and not all(metadata.get(key) == value for key, value in query.filters.items()):
                    continue
                if chunk.embedding is None:
                    continue
                results.append(scored(chunk_to_result_chunk(chunk, metadata), cosine(query.embedding, chunk.embedding)))
        results.sort(key=lambda item: item.score, reverse=True)
        return [
            apply_inclusion(item, include_content=query.include_content, include_metadata=query.include_metadata)
            for item in results[: query.top_k]
        ]

    async def get_chunk(self, chunk_id: str) -> SearchResult | None:
        collection = self._collection()
        if collection is None:
            return None
        source_id = collection.chunk_index.get(chunk_id)
        if source_id is None:
            return None
        for chunk in collection.chunks_by_source.get(source_id, []):
            if chunk.id == chunk_id:
                return unranked(chunk_to_result_chunk(chunk))
        return None

    def _require_source(self, source_id: str) -> list[DocumentChunk]:
        collection = self._collection()
        if collection is None or source_id not in collection.chunks_by_source:
            raise SourceNotFoundError(source_id)
        return collection.chunks_by_source[source_id]

    async def navigate(
        self,
        source_id: str,
        start_offset: int,
        end_offset: int,
        direction: NavigationDirection,
        *,
        top_k: int = 1,
        content_type: ChunkType = ChunkType.CONTENT,
        context: RetrievalContext = RetrievalContext(),
    ) -> list[SearchResult]:
        ordered = self._require_source(source_id)
        moved = navigate_offsets(ordered, start_offset, end_offset, direction, top_k, content_type)
        return [unranked(chunk_to_result_chunk(chunk)) for chunk in moved]

    async def read(
        self,
        source_id: str,
        start_offset: int | None,
        end_offset: int | None,
        *,
        content_type: ChunkType = ChunkType.CONTENT,
        top_k: int = 20,
        context: RetrievalContext = RetrievalContext(),
    ) -> list[SearchResult]:
        ordered = self._require_source(source_id)
        selected = read_offsets(ordered, start_offset, end_offset, content_type, top_k)
        return [unranked(chunk_to_result_chunk(chunk)) for chunk in selected]

    async def read_pages(
        self,
        source_id: str,
        start_page: int | None,
        end_page: int | None,
        *,
        content_type: ChunkType = ChunkType.CONTENT,
        top_k: int = 20,
        context: RetrievalContext = RetrievalContext(),
    ) -> list[SearchResult]:
        ordered = self._require_source(source_id)
        selected = read_page_range(ordered, start_page, end_page, content_type, top_k)
        return [unranked(chunk_to_result_chunk(chunk)) for chunk in selected]

    async def grep(
        self,
        source_id: str,
        pattern: str,
        *,
        mode: GrepMode = GrepMode.PHRASE,
        content_type: ChunkType = ChunkType.CONTENT,
        top_k: int = 5,
        context: RetrievalContext = RetrievalContext(),
    ) -> list[SearchResult]:
        ordered = self._require_source(source_id)
        matches = grep_chunks(ordered, pattern, mode, content_type)
        return [unranked(chunk_to_result_chunk(chunk)) for chunk in matches[:top_k]]

    async def grep_count(
        self,
        source_id: str,
        pattern: str,
        *,
        mode: GrepMode = GrepMode.PHRASE,
        content_type: ChunkType = ChunkType.CONTENT,
        top_k: int = 5,
    ) -> GrepOutcome:
        ordered = self._require_source(source_id)
        matches = grep_chunks(ordered, pattern, mode, content_type)
        results = [unranked(chunk_to_result_chunk(chunk)) for chunk in matches[:top_k]]
        return GrepOutcome(matches=results, total=len(matches))

    async def source_metas(self, source_ids: list[str]) -> dict[str, SourceMeta]:
        collection = self._collection()
        if collection is None:
            return {}
        return {sid: collection.sources[sid] for sid in source_ids if sid in collection.sources}


_STORES: dict[str, Collection] = {}


def get_local_store(collection_name: str) -> LocalSearchStore:
    return LocalSearchStore(collection_name)


def reset_local_stores() -> None:
    _STORES.clear()
