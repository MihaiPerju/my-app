"""PostgreSQL backend using the mistralai-search-toolkit-plugins-postgres plugin.

Replaces the hand-rolled store with a thin adapter around PostgresStoreIndex.
Lexical fusion is the plugin's, keyed off the query TEXT: ``PostgresStoreIndex.search``
returns a BM25+dense fused statement whenever ``query.query`` is non-empty and a BM25
index exists, and its dense statement otherwise. ``_run_search`` blanks the text to turn
fusion off, so this adapter needs no ``hybrid_search`` of its own.
source_metas() queries search_sources, which index_document() keeps in sync.
"""

from typing import Any

from db import get_engine
from db.models.search import EMBEDDING_DIM
from mistralai.search.toolkit.context import IngestContext, RetrievalContext
from mistralai.search.toolkit.document import ChunkType, Document
from mistralai.search.toolkit.embedding.models import MistralEmbeddingPreset, VectorDType
from mistralai.search.toolkit.plugins.postgres import PostgresCollectionSchema, PostgresStoreIndex
from mistralai.search.toolkit.search.errors import DocumentNotFoundError, SourceNotFoundError
from mistralai.search.toolkit.search.index import GrepMode, NavigationDirection
from mistralai.search.toolkit.search.models import SearchResult
from sqlalchemy import Integer, cast, func, select
from sqlalchemy.exc import SQLAlchemyError

from mistralai_capabilities.search.schemas import (
    _DEPLOYMENT_EMBED_MODEL,
    CollectionConfig,
    CollectionConfigMismatchError,
    FilteredVectorSearchQuery,
    UnsupportedSearchFilterError,
)
from mistralai_capabilities.search.store import GrepOutcome, SourceMetadataStore, resolve_doc_id


def _make_schema(collection_name: str) -> PostgresCollectionSchema:
    """The plugin's declaration of this deployment's chunk table.

    ``PostgresCollectionSchema`` takes an embedding *model*, not a bare dimension and metric: the
    width, dtype and distance all come off it, and the same declaration is what builds the table
    and names its HNSW index. So the model is resolved from the one the pipelines actually embed
    with, and cross-checked against ``EMBEDDING_DIM`` -- the width the chunk column is provisioned
    to. A deployment that changed ``INGESTION_EMBED_MODEL`` to a different width would otherwise
    declare a table the database will not accept.

    ``FLOAT16`` is not a preference either: it is what makes the declaration describe the table the
    plugin actually provisions. The dtype picks both the column type and the index suffix --
    ``FLOAT16`` gives ``halfvec(128)`` and ``..._hnsw_m16_efc64_hv_cos``, ``FLOAT32`` gives
    ``vector(128)`` and ``..._v_cos``. The plugin provisions the halfvec pair, so the default
    would leave the store querying a column type it did not declare and reindexing an index name
    that does not exist.
    """
    preset = MistralEmbeddingPreset.from_name(_DEPLOYMENT_EMBED_MODEL)
    if preset is None:
        raise CollectionConfigMismatchError(
            f"INGESTION_EMBED_MODEL {_DEPLOYMENT_EMBED_MODEL!r} is not a known embedding preset"
        )
    model = preset.build_embedding_model().model_copy(update={"dtype": VectorDType.FLOAT16})
    if model.dimensions != EMBEDDING_DIM:
        raise CollectionConfigMismatchError(
            f"This deployment stores {EMBEDDING_DIM}-dim vectors, but INGESTION_EMBED_MODEL "
            f"{_DEPLOYMENT_EMBED_MODEL!r} produces {model.dimensions}"
        )
    return PostgresCollectionSchema(
        collection_name=collection_name,
        document_type=Document,
        embedding_model=model,
    )


def _ilike_contains(column: Any, pattern: str) -> Any:
    escaped = pattern.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return column.ilike(f"%{escaped}%", escape="\\")


def get_postgres_store(collection_name: str) -> "PostgresSearchAdapter":
    schema = _make_schema(collection_name)
    index = PostgresStoreIndex(get_engine(), schema)
    return PostgresSearchAdapter(collection_name, index)


class PostgresSearchAdapter(SourceMetadataStore):
    def __init__(self, collection_name: str, index: PostgresStoreIndex) -> None:
        self.collection_name = collection_name
        self._index = index
        # Stable attributes set in PostgresStoreIndex.__init__. `_engine` is the plain one it
        # writes through; `_read_engine` is the same engine under `postgresql_readonly=True`, so
        # SELECTs take it and anything issuing DDL or DML must not.
        self._table = index._table
        self._engine = index._engine
        self._read_engine = index._read_engine

    async def ensure_collection(self, config: CollectionConfig) -> CollectionConfig:
        # Width alone is not identity. Dropping `search_collections` took away the row that
        # recorded which model wrote the vectors, so a request naming a *different* 128-dim model
        # would pass a dimension check and then search an incompatible embedding space -- same
        # arity, unrelated geometry, silently poor results. The deployment embeds everything with
        # `INGESTION_EMBED_MODEL`, so that name is the identity, and `search_ensure_collection`
        # already refuses a mismatch on the ingest side; this is the same rule on the read side.
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
        # The write engine: `CREATE TABLE` on `_read_engine` fails with
        # `ReadOnlySQLTransactionError`, which made every postgres-backed contract test error.
        async with self._engine.begin() as conn:
            await conn.run_sync(self._table.create, checkfirst=True)
        return config

    async def index_document(self, document: Document, context: IngestContext = IngestContext()) -> None:
        # A chunkless document still has metadata worth recording, and `LocalSearchStore` accepts
        # one, so the shared contract says both backends must. The plugin instead raises
        # `IndexingError("No chunks for document; use delete_document() to remove it")` -- a guard
        # against silently emptying a document, which is not what this is.
        #
        # Re-ingesting a source that previously had chunks as empty has to clear them: the plugin
        # replaces a document's chunks on index, so skipping the call would leave the old ones
        # searchable while the source row says the source is empty. Deleting is what
        # "index this document, which has no chunks" means.
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
            # Already gone is the success state, not a reason to stop: the previous attempt
            # deleted the chunks and then failed before clearing the source row, and the retry
            # lands here. Returning now would strand that row forever, because nothing after this
            # point ever looks for a document the plugin no longer has.
            pass
        if source_id is not None:
            await self._forget_source(source_id)

    async def search(
        self, query: FilteredVectorSearchQuery, context: RetrievalContext = RetrievalContext()
    ) -> list[SearchResult]:
        if query.filters:
            # `PostgresStoreIndex.search` reads top_k/embedding/exclude_ids/query and nothing
            # else, so filters handed to it vanish and the caller gets unrelated chunks back
            # under a contract that promised exact matching. Post-filtering the top_k here would
            # be no better -- the plugin warns that HNSW gathers candidates before the WHERE, so
            # filtering after the fact silently thins recall. Fail instead of answering wrongly.
            raise UnsupportedSearchFilterError(
                f"The postgres backend cannot apply metadata filters {sorted(query.filters)}; "
                "run the query without filters or select SEARCH_BACKEND=vespa"
            )
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
        # "Move zero chunks" is a well-formed request with an empty answer, which is what
        # `LocalSearchStore` returns and what the shared contract asserts. The plugin validates
        # `top_k >= 1` and raises `SearchError` instead, so answer it here rather than making an
        # agent's window arithmetic backend-dependent.
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
            # The plugin decides a source exists by looking for its chunks, so a document indexed
            # with none reads as unknown. `search_sources` is the record of what was ingested, and
            # it is what makes "indexed but empty" (an empty list) distinguishable from "never
            # seen" (this error) -- the distinction the contract draws either side of a delete.
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
        # page_number is stored inside the metadata JSONB blob as chunk.metadata.page_number
        page_num = cast(self._table.c.metadata["page_number"].astext, Integer)
        conditions: list[Any] = [
            self._table.c.source_id == source_id,
            self._table.c.chunk_type == content_type.value,
            self._table.c.metadata.has_key("page_number"),
        ]
        if start_page is not None:
            conditions.append(page_num >= start_page)
        if end_page is not None:
            conditions.append(page_num <= end_page)
        projected = [self._table.c[name] for name in self._table.c.keys() if name != "embedding"]
        statement = (
            select(*projected)
            .where(*conditions)
            .order_by(self._table.c.start_offset.asc())
            .limit(top_k)
        )
        from mistralai.search.toolkit.plugins.postgres.mapping import row_to_unranked_result
        from mistralai.search.toolkit.search.errors import SearchError
        try:
            async with self._read_engine.connect() as conn:
                result = await conn.execute(statement)
                records = result.mappings().all()
        except SQLAlchemyError as exc:
            raise SearchError("read_pages query failed") from exc
        results = [row_to_unranked_result(dict(record), self._index._custom_column_names) for record in records]
        if not results:
            # Distinguish empty page range from unknown source
            count_stmt = select(func.count()).select_from(self._table).where(
                self._table.c.source_id == source_id
            )
            try:
                async with self._read_engine.connect() as conn:
                    total = await conn.scalar(count_stmt)
            except SQLAlchemyError as exc:
                raise SearchError("read_pages source check failed") from exc
            # Same rule as `read`: the chunk table cannot tell "indexed but empty" from "never
            # seen", and `search_sources` can. Without this a chunkless source raises here while
            # `read` returns `[]` for it, which is the two methods disagreeing about the same
            # source.
            if not total and not await self._source_known(source_id):
                raise SourceNotFoundError(source_id)
        return results

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
        matches = await self._index.grep(source_id, pattern, mode=mode, content_type=content_type, top_k=top_k)
        # `PostgresStoreIndex.grep` answers a blank pattern with `[]` before it builds a WHERE.
        # The count below would build none either -- `pattern.split()` is empty in TERM mode, and
        # `%  %` matches nearly everything in PHRASE mode -- so it would return the source's whole
        # chunk count next to an empty match list. Same guard, same answer.
        if not pattern.strip():
            return GrepOutcome(matches=matches, total=0)
        conditions: list[Any] = [
            self._table.c.source_id == source_id,
            self._table.c.chunk_type == content_type.value,
        ]
        if mode == GrepMode.PHRASE:
            conditions.append(_ilike_contains(self._table.c.content, pattern))
        else:
            conditions.extend(_ilike_contains(self._table.c.content, token) for token in pattern.split())
        count_stmt = select(func.count()).select_from(self._table).where(*conditions)
        from mistralai.search.toolkit.search.errors import SearchError
        try:
            async with self._read_engine.connect() as conn:
                total = await conn.scalar(count_stmt) or 0
        except SQLAlchemyError as exc:
            raise SearchError("grep_count query failed") from exc
        return GrepOutcome(matches=matches, total=int(total))

