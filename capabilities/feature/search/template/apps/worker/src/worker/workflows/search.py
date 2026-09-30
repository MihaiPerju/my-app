"""Agentic Search workflow: the scheduled corpus reconcile sweep.

Retrieval (search / open / navigate / read / grep) is not modelled as workflows: those
activities carry their own ``@agents.tool`` decorator and attach to the search subagent's
harness. Only the multi-step reconcile sweep remains here. It is unrouted; the worker's
ingestion schedule triggers it, never HTTP.

Ingestion itself is the Workflows Search Plugin's: ``IngestDocumentsWorkflow`` routes each source
to a pipeline, cuts homogeneous batches, and fans them out as ``IngestBatchWorkflow`` children that
run extract / split / process / embed_and_index as four separate activities. This workflow keeps
the reconcile concerns the plugin has no opinion about — the manifest, the mass-purge guard,
tombstones and the ANN rebuild — and re-exports both plugin workflows so worker discovery
registers them.
"""

from datetime import timedelta

import mistralai.workflows as workflows
from mistralai.workflows import execute_workflow
from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    from mistralai.workflows.plugins.search import (
        DocumentRef,
        IngestBatchWorkflow,
        IngestDocumentsInput,
        IngestDocumentsWorkflow,
        IngestionExecutionPolicy,
    )
    from mistralai_capabilities.search import reconcile
    from mistralai_capabilities.search.schemas import (
        DeleteRequest,
        EnsureCollectionRequest,
        EnumerateRequest,
        ReconcileItem,
        ReconcilePlanRequest,
        ReconcileRequest,
        ReconcileResult,
        ReconcileSettings,
        RecordIngestedRequest,
        ReindexAnnRequest,
        TombstoneGcRequest,
    )

# The two plugin workflows are imported for a structural reason, not for readability: worker
# discovery walks module members with `inspect.getmembers`, and the plugin ships no
# `get_worker_interceptors` hook, so binding them to names here is the only thing that puts them on
# the worker. Drop either import and `execute_workflow` below starts a child no worker can pick up
# — `IngestBatchWorkflow` is never referenced in this module's code, only launched by the other.
__all__ = ["IngestBatchWorkflow", "IngestDocumentsWorkflow", "SearchReconcileWorkflow"]


@workflows.workflow.define(
    name="search_reconcile",
    workflow_display_name="Reconcile search corpus from storage",
    workflow_description="Enumerate the configured object store, ingest new/changed files, and remove deleted ones.",
    execution_timeout=timedelta(hours=8),
)
class SearchReconcileWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: ReconcileRequest) -> ReconcileResult:
        run_id = str(_wf.uuid4())
        settings = await reconcile.search_reconcile_settings(request)
        dry_run = settings.dry_run

        snapshot = (await reconcile.search_enumerate(EnumerateRequest(prefix=request.prefix))).items
        plan = await reconcile.search_reconcile_plan(
            ReconcilePlanRequest(collection_name=request.collection_name, run_id=run_id, snapshot=snapshot)
        )

        abort_reason = reconcile.reconcile_abort_reason(
            snapshot_count=plan.snapshot_count,
            existing_count=plan.existing_count,
            deleted_count=plan.deleted_count,
            delete_threshold=settings.delete_threshold,
            dry_run=dry_run,
        )
        if abort_reason is not None:
            return ReconcileResult(run_id=run_id, dry_run=dry_run, aborted=True, reason=abort_reason)

        changed = [item for item in plan.items if item.action in ("new", "updated")]
        deleted_keys = [item.source_key for item in plan.items if item.action == "deleted"]
        unchanged = sum(1 for item in plan.items if item.action == "unchanged")
        result = ReconcileResult(run_id=run_id, dry_run=dry_run, skipped=unchanged)

        if dry_run:
            result.created = sum(1 for item in changed if item.action == "new")
            result.updated = sum(1 for item in changed if item.action == "updated")
            result.deleted = len(deleted_keys)
            result.reason = "dry_run"
            return result

        # Only the delete sweep still strides by hand; ingestion batches inside `_ingest`.
        delete_batch = settings.batch_size
        if changed:
            await reconcile.search_ensure_collection(
                EnsureCollectionRequest(collection_name=request.collection_name, embed_model=request.embed_model)
            )
            await self._ingest(request, settings, run_id, changed, result)

        for start in range(0, len(deleted_keys), delete_batch):
            removal = await reconcile.search_delete(
                DeleteRequest(
                    collection_name=request.collection_name,
                    source_keys=deleted_keys[start : start + delete_batch],
                    run_id=run_id,
                )
            )
            result.deleted += removal.deleted
            result.failed += removal.failed

        if settings.tombstone_gc_days > 0:
            await reconcile.search_tombstone_gc(
                TombstoneGcRequest(
                    collection_name=request.collection_name,
                    older_than_days=settings.tombstone_gc_days,
                )
            )

        # Writes degrade the ANN index rather than just fragmenting it: rows inserted
        # into an existing diskann index answer top-10 at ~0.20 recall against ~1.00
        # for a rebuilt one. Rebuilding once per sweep is what keeps the index an
        # improvement over the exact scan it replaced.
        if result.created or result.updated or result.deleted:
            await reconcile.search_reindex_ann(ReindexAnnRequest(collection_name=request.collection_name))
        return result

    async def _ingest(
        self,
        request: ReconcileRequest,
        settings: ReconcileSettings,
        run_id: str,
        changed: list[ReconcileItem],
        result: ReconcileResult,
    ) -> None:
        """Ingest the changed sources one wave at a time, fingerprinting each wave that comes back.

        A wave is one ``IngestDocumentsWorkflow``. The plugin owns routing, batching, the bounded
        child fan-out and failure aggregation; this workflow owns only the manifest write between
        waves. Handing it the whole corpus in a single call — the obvious shape — would make the
        entire sweep the unit of recovery: a pass that died late would re-extract and re-embed
        every source it had already indexed. Cutting the corpus first keeps the plugin canonical
        and the manifest wave-grained.

        A wave is ``batch_size * max_concurrent_batches`` sources, which is exactly what the child
        runs concurrently, so it completes in one internal fan-out and adds no serialization. The
        cost is that routing groups by pipeline *within* a wave rather than across the corpus, so a
        mixed-type corpus cuts a few more, smaller batches than one whole-corpus plan would.
        """
        policy = IngestionExecutionPolicy(
            batch_size=settings.batch_size,
            max_concurrent_batches=settings.max_concurrent_batches,
        )
        wave_size = policy.batch_size * policy.max_concurrent_batches
        router_name = reconcile.router_name(request.collection_name)

        for start in range(0, len(changed), wave_size):
            wave = changed[start : start + wave_size]
            # `wait` defaults to True, which the SDK maps to ParentClosePolicy.TERMINATE: a sweep
            # that timed out must not leave children indexing against a run the next sweep retries.
            outcome = await execute_workflow(
                IngestDocumentsWorkflow,
                IngestDocumentsInput(
                    router_name=router_name,
                    # `source_id` is set to the storage key so failures come back keyed the way the
                    # manifest is; left unset it would default to the same value, but not by
                    # contract.
                    refs=[
                        DocumentRef(
                            path=item.source_key,
                            name=item.source_key.rsplit("/", 1)[-1],
                            source_id=item.source_key,
                        )
                        for item in wave
                    ],
                    policy=policy,
                ),
            )
            # `outcome.failures` already folds in the unroutable references — a source no pipeline
            # claims never reaches a batch, and must not enter the manifest either.
            recorded = await reconcile.search_record_ingested(
                RecordIngestedRequest(
                    collection_name=request.collection_name,
                    run_id=run_id,
                    items=wave,
                    failed_source_keys=[failure.source_id for failure in outcome.failures],
                )
            )
            result.created += recorded.created
            result.updated += recorded.updated
            result.failed += recorded.failed
