"""Vespa backend using the mistralai-search-toolkit-plugins-vespa plugin.

Wraps the VespaStoreIndex returned by VespaApp.get_search_index() with a thin adapter
that satisfies the SearchStore protocol and keeps SearchSource in sync for source_metas().
Hybrid BM25 + dense search is served natively by Vespa via the "hybrid-search" query
profile defined in the schema migration.
"""

from pathlib import Path
from typing import Any

from db.models.search import EMBEDDING_DIM
from env.search import env
from mistralai.search.toolkit.context import IngestContext, RetrievalContext
from mistralai.search.toolkit.document import ChunkType, Document
from mistralai.search.toolkit.plugins.vespa import VespaApp, VespaClientConfig
from mistralai.search.toolkit.search.errors import DocumentNotFoundError, SourceNotFoundError
from mistralai.search.toolkit.search.index import GrepMode, NavigationDirection
from mistralai.search.toolkit.search.models import SearchResult

from mistralai_capabilities.search.schemas import (
    _DEPLOYMENT_EMBED_MODEL,
    CollectionConfig,
    CollectionConfigMismatchError,
    FilteredVectorSearchQuery,
)
from mistralai_capabilities.search.store import GrepOutcome, SourceMetadataStore, resolve_doc_id

_VESPA_APP = VespaApp(Path(__file__).parent / "vespa_app")


def _effective_endpoint() -> str:
    return env.vespa_endpoint or f"http://localhost:{env.vespa_query_port}"


def get_vespa_store(collection_name: str) -> "VespaSearchAdapter":
    index = _VESPA_APP.get_search_index(
        VespaClientConfig(endpoint=_effective_endpoint()),
        collection_name=collection_name,
    )
    return VespaSearchAdapter(collection_name, index)


class VespaSearchAdapter(SourceMetadataStore):
    def __init__(self, collection_name: str, index: Any) -> None:
        self.collection_name = collection_name
        self._index = index

    async def ensure_collection(self, config: CollectionConfig) -> CollectionConfig:
        # Same rule as the postgres adapter: width is not identity, and nothing persists which
        # model wrote the vectors, so the deployment's `INGESTION_EMBED_MODEL` is the identity.
        if config.embed_model != _DEPLOYMENT_EMBED_MODEL:
            raise CollectionConfigMismatchError(
                f"This deployment embeds with {_DEPLOYMENT_EMBED_MODEL!r} (INGESTION_EMBED_MODEL); "
                f"collection {self.collection_name!r} was asked for {config.embed_model!r}"
            )
        if config.embed_dim != EMBEDDING_DIM:
            raise CollectionConfigMismatchError(
                f"This deployment stores {EMBEDDING_DIM}-dim vectors; "
                f"collection {self.collection_name!r} requested {config.embed_dim} "
                f"(embed_model {config.embed_model!r})"
            )
        return config

    async def index_document(self, document: Document, context: IngestContext = IngestContext()) -> None:
        # Same contract as the postgres adapter, for the same reason: a chunkless document is
        # recorded, and re-ingesting a source as empty clears whatever it had before.
        if document.chunks:
            await self._index.index_document(document, context)
        else:
            try:
                await self._index.delete_document(resolve_doc_id(document), context)
            except DocumentNotFoundError:
                pass
        await self._record_source(document)

    async def delete_document(self, doc_id: str, context: IngestContext = IngestContext()) -> None:
        source_id = await self._source_id_for_doc(doc_id)
        try:
            await self._index.delete_document(doc_id, context)
        except DocumentNotFoundError:
            # Already gone is the success state -- see the identical note in postgres_store: the
            # retry after a half-finished delete must still clear the source row.
            pass
        if source_id is not None:
            await self._forget_source(source_id)

    async def search(
        self, query: FilteredVectorSearchQuery, context: RetrievalContext = RetrievalContext()
    ) -> list[SearchResult]:
        return await self._index.search(query, context)

    async def get_chunk(self, chunk_id: str) -> SearchResult | None:
        return await self._index.get_chunk(chunk_id)

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
        # "Move zero chunks" is an empty answer, not an error -- the same normalisation the
        # postgres adapter makes, so window arithmetic is not backend-dependent.
        if top_k <= 0:
            return []
        return await self._index.navigate(
            source_id, start_offset, end_offset, direction,
            top_k=top_k, content_type=content_type, context=context,
        )

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
        try:
            return await self._index.read(
                source_id, start_offset, end_offset,
                content_type=content_type, top_k=top_k, context=context,
            )
        except SourceNotFoundError:
            # The Vespa index is document-per-chunk, so a source recorded with no chunks has no
            # document and reads as unknown. `search_sources` is what makes "indexed but empty"
            # (an empty list) distinguishable from "never seen" (this error) -- the same rule the
            # postgres adapter applies, so navigation is not backend-dependent.
            if await self._source_known(source_id):
                return []
            raise

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
        # Vespa exposes no page-range filter here, so the pages are selected in Python. The source
        # is walked in windows rather than read as one capped prefix: a source with more chunks
        # than `SEARCH_MAX_ATOMS_PER_SOURCE` would otherwise report an existing later page as
        # empty, because every chunk on it fell outside the prefix that was fetched.
        #
        # Each window resumes at the `start_offset` of the last row it saw -- the continuation key
        # is the ordering key, since `read` returns chunks with `start_offset >= cursor` ordered by
        # `start_offset`. Resuming past the greatest `end_offset` instead would skip a later chunk
        # whose `start_offset` falls inside an earlier chunk's span (chunks overlap), silently
        # dropping it from a later page. The boundary row is re-read and dropped by `seen`.
        # Scanning stops once `top_k` matches are in hand, the source runs out, or the cursor
        # cannot advance.
        window = env.search_max_atoms_per_source
        results: list[SearchResult] = []
        seen: set[str] = set()
        cursor: int | None = None
        while len(results) < top_k:
            try:
                batch = await self._index.read(
                    source_id, cursor, None,
                    content_type=content_type, top_k=window, context=context,
                )
            except SourceNotFoundError:
                # The plugin may signal a chunkless/unknown source either way; the post-loop
                # `_source_known` check below is what draws the empty-vs-unknown line.
                break
            if not batch:
                break
            fresh = [item for item in batch if item.chunk.id not in seen]
            for item in fresh:
                seen.add(item.chunk.id)
                page = item.chunk.metadata.get("page_number")
                if page is None:
                    continue
                try:
                    page_num = int(page)
                except (TypeError, ValueError):
                    continue
                if start_page is not None and page_num < start_page:
                    continue
                if end_page is not None and page_num > end_page:
                    continue
                results.append(item)
                if len(results) == top_k:
                    break
            if len(batch) < window:
                break
            nxt = batch[-1].chunk.start_offset or 0
            if cursor is not None and nxt <= cursor:
                # A full window whose last row does not advance past where we resumed means more
                # than `window` chunks share one `start_offset`; another identical read would loop.
                break
            cursor = nxt
        if not results and not await self._source_known(source_id):
            # The plugin's `read` returns an empty batch for a chunkless source and for an unknown
            # one alike; `search_sources` is what tells them apart. An indexed empty source is `[]`;
            # a never-seen source raises, matching `read` and the postgres adapter.
            raise SourceNotFoundError(source_id)
        return results[:top_k]

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
        return await self._index.grep(
            source_id, pattern, mode=mode, content_type=content_type, top_k=top_k, context=context,
        )

    async def grep_count(
        self,
        source_id: str,
        pattern: str,
        *,
        mode: GrepMode = GrepMode.PHRASE,
        content_type: ChunkType = ChunkType.CONTENT,
        top_k: int = 5,
    ) -> GrepOutcome:
        """Count by fetching, because the Vespa plugin exposes no count query.

        Vespa itself knows the answer -- every response carries ``root.fields.totalCount`` -- but
        ``VespaStoreIndex`` only returns transformed hits, and the plugin's ``grep`` takes a limit
        and no offset, so there is nothing to paginate with either. So this fetches one past the
        cap: overshooting proves the total is larger than we can see, and the outcome says so
        rather than reporting the cap as if it were the count.
        """
        cap = env.search_max_atoms_per_source
        found = await self._index.grep(
            source_id, pattern, mode=mode, content_type=content_type, top_k=cap + 1,
        )
        truncated = len(found) > cap
        return GrepOutcome(matches=found[:top_k], total=min(len(found), cap), truncated=truncated)
