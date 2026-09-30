"""Scheduled reconciling ingestion activities for ``search``.

These activities enumerate an object-storage source, diff it against the
``IngestionSourceState`` manifest, and soft-delete vanished sources. The re-ingest itself is
**not** an activity here: it runs through the Workflows Search Plugin's four staged activities
(extract / split / process / embed_and_index), which resolve a live Search Toolkit ``Pipeline``
from a process-global registry. This module owns the registration
(:func:`register_search_pipelines`) and the manifest bookkeeping either side of it; object storage
and the Mistral SDK pipeline stay in this layer, like every other activity module.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

import mistralai.workflows as workflows
import structlog
from db import get_engine, get_session_maker
from db.models.ingestion import IngestionSourceState
from env.ingestion import env as ingestion_env
from env.mistral import env as mistral_env
from env.workflows import env as workflows_env
from mistralai.client import Mistral
from mistralai.search.toolkit.context import IngestContext, RetrievalContext
from mistralai.search.toolkit.document import Document, compute_id
from mistralai.search.toolkit.search.errors import DocumentNotFoundError, SourceNotFoundError
from mistralai.search.toolkit.search.index import VectorStoreIndex
from mistralai.search.toolkit.search.models import SearchResult, VectorSearchQuery
from mistralai.search.toolkit.storage import ObjectStorage
from mistralai.workflows import Depends
from mistralai.workflows.plugins.search import PipelineRegistry, UnknownRouterError, pipeline_registry
from mistralai_capabilities.search.activities import _infer_dim, _open_store
from mistralai_capabilities.search.schemas import (
    CollectionConfig,
    CollectionConfigMismatchError,
    DeleteRequest,
    DeleteResult,
    EnsureCollectionRequest,
    EnumerateRequest,
    EnumerateResult,
    ReconcileItem,
    ReconcilePlan,
    ReconcilePlanRequest,
    ReconcileRequest,
    ReconcileSettings,
    RecordIngestedRequest,
    RecordIngestedResult,
    ReindexAnnRequest,
    ReindexAnnResult,
    SourceSnapshotItem,
    TombstoneGcRequest,
    TombstoneGcResult,
)
from mistralai_capabilities.search.store import SearchStore
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import col

if TYPE_CHECKING:
    from mistralai.search.toolkit.ingestion.extractors import DocumentExtractor
    from mistralai.search.toolkit.ingestion.pipelines import Pipeline

logger = structlog.get_logger("search.reconcile")


def _ann_index_name(collection_name: str) -> str | None:
    """The HNSW index on the plugin's chunk table, or ``None`` if the collection declares none.

    Read off the declared table rather than spelled out here: the plugin composes the name from
    the table, ``m``, ``ef_construction``, the vector type and the metric
    (``..._hnsw_m16_efc64_hv_cos``), and a literal copy would rot the first time any of those
    moves. The search plugin provisions exactly this index, from the same
    declaration.
    """
    from mistralai_capabilities.search.postgres_store import _make_schema

    table = _make_schema(collection_name).to_table()
    for index in table.indexes:
        if index.dialect_options["postgresql"].get("using") == "hnsw":
            return index.name
    return None


_MAX_SOURCE_KEY_LEN = 255
_CHUNK_SIZE = 512
_ROUTED_PROTOCOLS = ("ocr", "image", "plain_text", "html", "email", "audio")


def router_name(collection_name: str) -> str:
    """The plugin-registry name of the router that ingests ``collection_name``.

    Keyed on the collection rather than fixed, so a request naming a collection this worker did
    not register fails loudly with the plugin's ``UnknownRouterError`` instead of silently
    indexing into the one collection that *is* registered.
    """
    return f"search:{collection_name}"


def _pipeline_name(collection_name: str, protocol: str) -> str:
    return f"{router_name(collection_name)}:{protocol}"


class IngestionBackendUnavailableError(RuntimeError):
    """Raised when no object-storage backend is configured for ingestion."""


class _VectorStoreAdapter(VectorStoreIndex):
    """Presents the app store to the SDK pipeline as a ``VectorStoreIndex``.

    The pipeline only embeds chunks for a ``VectorStoreIndex``; the app stores subclass the plainer
    ``StoreIndex``. This ingest-only adapter delegates writes to the real store.
    """

    def __init__(self, inner: SearchStore) -> None:
        self._inner = inner

    async def index_document(self, document: Document, context: IngestContext = IngestContext()) -> None:
        await self._inner.index_document(document)

    async def delete_document(self, doc_id: str, context: IngestContext = IngestContext()) -> None:
        await self._inner.delete_document(doc_id)

    async def search(
        self, query: VectorSearchQuery, context: RetrievalContext = RetrievalContext()
    ) -> list[SearchResult]:
        raise NotImplementedError("_VectorStoreAdapter is ingest-only")


def _open_object_storage() -> ObjectStorage:
    backend = ingestion_env.ingestion_storage_backend
    if backend == "filesystem":
        from mistralai.search.toolkit.storage import FilesystemStorage

        root = ingestion_env.ingestion_filesystem_root
        if not root or Path(root).resolve() == Path("/"):
            raise IngestionBackendUnavailableError(
                "ingestion_filesystem_root must be set to a non-root directory for the filesystem backend"
            )
        return FilesystemStorage(root=root)
    if backend == "s3":
        from mistralai.search.toolkit.plugins.storage.s3 import S3BlobStorage

        return S3BlobStorage(
            bucket_name=ingestion_env.ingestion_s3_bucket,
            region_name=ingestion_env.ingestion_s3_region or None,
            endpoint_url=ingestion_env.ingestion_s3_endpoint_url or None,
            aws_access_key_id=ingestion_env.ingestion_s3_access_key_id or None,
            aws_secret_access_key=ingestion_env.ingestion_s3_secret_access_key or None,
            aws_session_token=ingestion_env.ingestion_s3_session_token or None,
        )
    if backend == "gcs":
        from mistralai.search.toolkit.plugins.storage.gcs import GCSBlobStorage

        return GCSBlobStorage(
            bucket_name=ingestion_env.ingestion_gcs_bucket,
            service_account_file=ingestion_env.ingestion_gcs_service_account_file or None,
            api_root=ingestion_env.ingestion_gcs_api_root or None,
        )
    if backend == "azure":
        from mistralai.search.toolkit.plugins.storage.azure import AzureBlobStorage

        return AzureBlobStorage(
            container_name=ingestion_env.ingestion_azure_container,
            azure_connection_string=ingestion_env.ingestion_azure_connection_string or None,
            account_url=ingestion_env.ingestion_azure_account_url or None,
            use_workload_identity=ingestion_env.ingestion_azure_use_workload_identity,
        )
    raise IngestionBackendUnavailableError(f"Unknown ingestion storage backend {backend!r}")


def _build_pipelines(client: Mistral, store: SearchStore, embed_model: str) -> dict[str, "Pipeline"]:
    """The per-protocol ingestion pipelines, wired to load their own bytes.

    Unlike the pre-0.0.13 shape, every pipeline carries a ``loader``: the plugin's ``extract``
    activity is handed a key, not bytes, so downloading is the pipeline's job now. ``FileLoader``
    ``stat``s before it ``get``s and raises the toolkit's non-retryable
    ``FileSizeLimitExceededException`` past the limit, which the stage records as a per-document
    failure — the same outcome the hand-rolled two-tier size guard produced, one download cheaper.

    Returned as the protocol map rather than an assembled ``RoutedPipeline`` because both are
    needed: the router answers ``plan_batches``, and each pipeline object must also be registered
    under its own name for the stage activities to resolve it.
    """
    from mistralai.search.toolkit.embedders import MistralEmbedder
    from mistralai.search.toolkit.ingestion.extractors import (
        EmailExtractor,
        HTMLExtractor,
        MistralAudioTranscriptionExtractor,
        MistralOCRExtractor,
        PlainTextExtractor,
    )
    from mistralai.search.toolkit.ingestion.loaders import FileLoader
    from mistralai.search.toolkit.ingestion.pipelines import Pipeline
    from mistralai.search.toolkit.ingestion.text_splitters import CharacterTextSplitter

    embedder = MistralEmbedder(client, model_name=embed_model)
    splitter = CharacterTextSplitter(chunk_size=_CHUNK_SIZE)
    indexed = _VectorStoreAdapter(store)
    loader = FileLoader(_open_object_storage, max_file_size=ingestion_env.ingestion_max_file_bytes)

    def pipe(extractor: "DocumentExtractor") -> Pipeline:
        return Pipeline(loader=loader, extractor=extractor, text_splitter=splitter, stores=indexed, embedder=embedder)

    ocr = MistralOCRExtractor(client)
    return {
        "ocr": pipe(ocr),
        "image": pipe(ocr),
        "plain_text": pipe(PlainTextExtractor()),
        "html": pipe(HTMLExtractor()),
        "email": pipe(EmailExtractor()),
        "audio": pipe(MistralAudioTranscriptionExtractor(client)),
    }


def register_search_pipelines(collection_name: str, embed_model: str) -> None:
    """Publish this deployment's pipelines to the plugin's process-global registry.

    A ``Pipeline`` holds open clients, so it cannot travel in a Temporal payload: the plugin's
    stage activities carry a *name* and resolve the object from worker state. Registering the
    router alone is not enough — every pipeline it can hand back must have a name of its own, or
    the batch ``plan_batches`` produced has nothing to label itself with.

    Guarded on the router already being present, because ``register``/``register_router`` raise on
    a duplicate name and the dependency below can be entered twice in one test process.
    """
    from mistralai.search.toolkit.ingestion.pipelines import RoutedPipeline

    name = router_name(collection_name)
    try:
        pipeline_registry.get_router(name)
    except UnknownRouterError:
        pass
    else:
        return

    client = Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)
    pipelines = _build_pipelines(client, _open_store(collection_name), embed_model)
    for protocol, pipeline in pipelines.items():
        pipeline_registry.register(_pipeline_name(collection_name, protocol), pipeline)
    pipeline_registry.register_router(name, RoutedPipeline(pipelines))
    logger.info(
        "registered search ingestion pipelines",
        router=name,
        protocols=sorted(pipelines),
        embed_model=embed_model,
    )


@asynccontextmanager
async def ingestion_pipelines() -> AsyncGenerator[PipelineRegistry, None]:
    """Worker-startup hook for the plugin registry, expressed as a workflow dependency.

    The SDK enters every ``Depends`` provider exactly once per worker process, inside
    ``run_worker``'s ``with_dependencies()`` — the only point that is both (a) after the
    environment is in place, so ``MISTRAL_API_KEY`` is readable, and (b) before any activity runs,
    on **every** replica. Registering at import instead would build an OCR extractor and a store in
    every process that merely imports this module, tests included; registering from an activity
    would leave the registry empty on whichever replica happened not to run it.
    """
    register_search_pipelines(ingestion_env.ingestion_collection_name, ingestion_env.ingestion_embed_model)
    yield pipeline_registry


def _fingerprint_match(row: IngestionSourceState, snap: SourceSnapshotItem) -> bool:
    if snap.etag and row.etag:
        return row.etag == snap.etag
    if snap.mtime and row.mtime:
        return row.mtime == snap.mtime
    return False


def reconcile_abort_reason(
    *, snapshot_count: int, existing_count: int, deleted_count: int, delete_threshold: float, dry_run: bool
) -> str | None:
    """Return why a reconcile pass must abort before mutating, or None to proceed.

    It guards against mass-purge. An empty snapshot when sources exist usually means a broken
    loader. It refuses to delete more than ``delete_threshold`` of the corpus unless it is a dry run.
    """
    if snapshot_count == 0 and existing_count > 0:
        return "empty snapshot with existing sources; refusing to purge the corpus"
    if not dry_run and existing_count > 0 and deleted_count / existing_count > delete_threshold:
        return f"delete ratio {deleted_count}/{existing_count} exceeds threshold {delete_threshold}"
    return None


async def _manifest_upsert(collection_name: str, items: list[ReconcileItem], run_id: str) -> None:
    """Fingerprint a whole wave in one statement, inside one transaction.

    One multi-row ``INSERT ... ON CONFLICT DO UPDATE`` rather than a ``merge`` per source. Two
    reasons, and the second is the one that bites: the wave is the documented unit of manifest
    recording, so a partial write is a state the design does not describe; and a session per source
    turned each parallel wave into ``batch_size * max_concurrent_batches`` serial round trips
    immediately after the fan-out that was concurrent.

    ``deleted_at`` is reset unconditionally — re-ingesting a source is exactly what un-tombstones a
    key that came back.
    """
    if not items:
        return
    now = datetime.now(UTC)
    statement = pg_insert(IngestionSourceState).values(
        [
            {
                "collection_name": collection_name,
                "source_key": item.source_key,
                "size": item.size,
                "etag": item.etag,
                "mtime": item.mtime,
                "last_seen_at": now,
                "deleted_at": None,
                "run_id": run_id,
            }
            for item in items
        ]
    )
    statement = statement.on_conflict_do_update(
        index_elements=["collection_name", "source_key"],
        set_={
            "size": statement.excluded.size,
            "etag": statement.excluded.etag,
            "mtime": statement.excluded.mtime,
            "last_seen_at": statement.excluded.last_seen_at,
            "deleted_at": statement.excluded.deleted_at,
            "run_id": statement.excluded.run_id,
        },
    )
    async with get_session_maker()() as session, session.begin():
        await session.execute(statement)


@workflows.activity(
    name="search.enumerate",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_enumerate(request: EnumerateRequest) -> EnumerateResult:
    prefix = request.prefix if request.prefix is not None else (ingestion_env.ingestion_source_prefix or None)
    storage = _open_object_storage()
    async with storage:
        metas = await storage.list_objects(prefix=prefix)
    candidates = [meta for meta in metas if not meta.key.endswith("/")]
    too_long = [meta.key for meta in candidates if len(meta.key) > _MAX_SOURCE_KEY_LEN]
    if too_long:
        logger.warning(
            "skipping source keys longer than the max identifier length; they will not be ingested",
            max_len=_MAX_SOURCE_KEY_LEN,
            count=len(too_long),
            sample=too_long[:10],
        )
    items = [
        SourceSnapshotItem(source_key=meta.key, size=meta.size, etag=meta.etag, mtime=meta.last_modified)
        for meta in candidates
        if len(meta.key) <= _MAX_SOURCE_KEY_LEN
    ]
    return EnumerateResult(items=items)


@workflows.activity(
    name="search.reconcile_settings",
    start_to_close_timeout=timedelta(seconds=30),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_reconcile_settings(request: ReconcileRequest) -> ReconcileSettings:
    return ReconcileSettings(
        delete_threshold=ingestion_env.ingestion_delete_threshold,
        batch_size=ingestion_env.ingestion_batch_size,
        max_concurrent_batches=ingestion_env.ingestion_max_concurrent_batches,
        tombstone_gc_days=ingestion_env.ingestion_tombstone_gc_days,
        dry_run=request.dry_run or ingestion_env.ingestion_dry_run,
    )


@workflows.activity(
    name="search.reconcile_plan",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_reconcile_plan(request: ReconcilePlanRequest) -> ReconcilePlan:
    snapshot = {item.source_key: item for item in request.snapshot}
    async with get_session_maker()() as session:
        rows = (
            (
                await session.execute(
                    select(IngestionSourceState).where(
                        col(IngestionSourceState.collection_name) == request.collection_name,
                        col(IngestionSourceState.deleted_at).is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
    manifest = {row.source_key: row for row in rows}

    items: list[ReconcileItem] = []
    for key, snap in snapshot.items():
        row = manifest.get(key)
        if row is None:
            action = "new"
        elif row.size == snap.size and _fingerprint_match(row, snap):
            action = "unchanged"
        else:
            action = "updated"
        items.append(ReconcileItem(source_key=key, action=action, size=snap.size, etag=snap.etag, mtime=snap.mtime))

    deleted_keys = [key for key in manifest if key not in snapshot]
    items.extend(ReconcileItem(source_key=key, action="deleted") for key in deleted_keys)

    return ReconcilePlan(
        collection_name=request.collection_name,
        run_id=request.run_id,
        items=items,
        snapshot_count=len(snapshot),
        existing_count=len(manifest),
        deleted_count=len(deleted_keys),
    )


@workflows.activity(
    name="search.ensure_collection",
    start_to_close_timeout=timedelta(seconds=60),
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_ensure_collection(
    request: EnsureCollectionRequest,
    pipelines: PipelineRegistry = Depends(ingestion_pipelines),
) -> CollectionConfig:
    """Make the corpus and this worker's ingestion pipelines ready, in that order.

    ``pipelines`` is declared for its startup side effect as much as its value: entering the
    dependency is what registers the router the staged activities resolve. Asking for the router
    back turns a worker that registered a *different* collection into a failure here — one
    activity before the fan-out — rather than a corpus quietly indexed into the wrong place.

    The embedding model needs the same guard for the same reason, and cannot borrow the router's.
    ``register_search_pipelines`` builds every embedder from ``INGESTION_EMBED_MODEL``, but the
    collection is sized from the request: a run asking for ``mistral-embed-dim256-2510`` against a
    ``dim128`` deployment would create a 256-dimensional collection and then feed it 128-dimensional
    vectors. Postgres physically types its vector column and would reject that on the config row;
    the local backend would accept both and answer with a corpus half of which is unsearchable.
    """
    if request.embed_model != ingestion_env.ingestion_embed_model:
        raise CollectionConfigMismatchError(
            f"This worker's pipelines embed with {ingestion_env.ingestion_embed_model!r} "
            f"(INGESTION_EMBED_MODEL); request asked for {request.embed_model!r}"
        )
    pipelines.get_router(router_name(request.collection_name))
    store = _open_store(request.collection_name)
    return await store.ensure_collection(
        CollectionConfig(
            collection_name=request.collection_name,
            embed_model=request.embed_model,
            embed_dim=_infer_dim(request.embed_model),
        )
    )


@workflows.activity(
    name="search.record_ingested",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_record_ingested(request: RecordIngestedRequest) -> RecordIngestedResult:
    """Fingerprint every source a wave indexed, and count the ones it could not.

    Called after the wave's ingest workflow returns, never before: the manifest is what stops the
    next sweep re-ingesting a source, so recording one the index never received would drop it
    silently. A crash between the index write and this activity re-ingests the wave next sweep
    instead, which is idempotent — ``index_document`` replaces a source's atoms wholesale.

    Wave-grained rather than document-grained, which is the one thing lost by moving ingestion
    into the plugin: the stages report failures per source, so successes are the complement, and
    the whole complement is written by one statement.
    """
    failed = set(request.failed_source_keys)
    indexed = [item for item in request.items if item.source_key not in failed]
    await _manifest_upsert(request.collection_name, indexed, request.run_id)
    return RecordIngestedResult(
        created=sum(1 for item in indexed if item.action == "new"),
        updated=sum(1 for item in indexed if item.action != "new"),
        failed=len(request.items) - len(indexed),
    )


@workflows.activity(
    name="search.delete",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_delete(request: DeleteRequest) -> DeleteResult:
    store = _open_store(request.collection_name)
    deleted = 0
    failed = 0
    for source_key in request.source_keys:
        try:
            await store.delete_document(compute_id(source_key))
        except (SourceNotFoundError, DocumentNotFoundError):
            # Already gone (e.g. a crash after a prior delete but before the tombstone): the
            # desired end state holds, so still tombstone.
            pass
        except Exception:
            failed += 1
            continue
        async with get_session_maker()() as session, session.begin():
            row = await session.get(IngestionSourceState, (request.collection_name, source_key))
            if row is not None:
                row.deleted_at = datetime.now(UTC)
                row.run_id = request.run_id
                session.add(row)
        deleted += 1
    return DeleteResult(collection_name=request.collection_name, deleted=deleted, failed=failed)


@workflows.activity(
    name="search.tombstone_gc",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_tombstone_gc(request: TombstoneGcRequest) -> TombstoneGcResult:
    cutoff = datetime.now(UTC) - timedelta(days=request.older_than_days)
    async with get_session_maker()() as session, session.begin():
        outcome = await session.execute(
            sa_delete(IngestionSourceState).where(
                col(IngestionSourceState.collection_name) == request.collection_name,
                col(IngestionSourceState.deleted_at).is_not(None),
                col(IngestionSourceState.deleted_at) < cutoff,
            )
        )
    return TombstoneGcResult(purged=int(getattr(outcome, "rowcount", 0) or 0))


@workflows.activity(
    name="search.reindex_ann",
    start_to_close_timeout=timedelta(hours=2),
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def search_reindex_ann(request: ReindexAnnRequest) -> ReindexAnnResult:
    """Rebuild the collection's HNSW index after a write pass, restoring its recall.

    Incremental inserts build a badly connected graph: measured on 5k rows, they answer top-10 with
    recall 0.20 against 1.00 for a bulk-built index, so the reconcile sweep must rebuild once per
    pass. ``CONCURRENTLY`` keeps corpus search answerable and forbids a transaction, so this uses
    the AUTOCOMMIT connection. This is postgres-only; other backends return early.

    The target is derived from the collection the request names, not spelled out: the plugin's
    chunk table declares its own HNSW index (``..._hnsw_m16_efc64_hv_cos``), which
    the search plugin provisions. A hardcoded name -- the old ``ix_search_atoms_diskann`` was one --
    reports "no ANN index" the moment the declaration moves and silently stops maintaining anything.
    """
    from env.search import env as search_env

    if search_env.search_backend != "postgres":
        return ReindexAnnResult(
            reindexed=False,
            reason=f"ANN reindex is postgres-only; current backend is {search_env.search_backend!r}",
        )
    index_name = _ann_index_name(request.collection_name)
    if index_name is None:
        return ReindexAnnResult(reindexed=False, reason="this collection declares no ANN index")
    engine = get_engine()
    async with engine.connect() as connection:
        autocommit = await connection.execution_options(isolation_level="AUTOCOMMIT")
        exists = (
            await autocommit.execute(
                sa_text("SELECT 1 FROM pg_indexes WHERE indexname = :name"),
                {"name": index_name},
            )
        ).first()
        if exists is None:
            return ReindexAnnResult(reindexed=False, reason="no ANN index on this deployment")
        await autocommit.execute(sa_text(f"REINDEX INDEX CONCURRENTLY {index_name}"))
    logger.info("search.reindex_ann rebuilt the ANN index", index=index_name)
    return ReindexAnnResult(reindexed=True)
