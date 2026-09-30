"""Feature-scoped tests for scheduled reconciling ingestion (mocked; no network)."""

from datetime import UTC, datetime
from typing import Any, Self

import mistralai_capabilities.search.reconcile as reconcile
import pytest
import worker.workflows.search as workflow_module
from db.models.ingestion import IngestionSourceState
from mistralai.client.errors import MistralError
from mistralai.client.models import WorkflowScheduleRequest
from mistralai.search.toolkit.document import compute_id
from mistralai.search.toolkit.search.errors import DocumentNotFoundError, SourceNotFoundError
from mistralai.search.toolkit.storage import ObjectMetadata
from mistralai.workflows import ScheduleOverlapPolicy
from mistralai.workflows.core.dependencies import DependencyInjector
from mistralai.workflows.plugins.search import (
    DocumentFailure,
    IngestDocumentsOutput,
)
from mistralai_capabilities.search.reconcile import reconcile_abort_reason
from mistralai_capabilities.search.schemas import (
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
    ReconcileResult,
    ReconcileSettings,
    RecordIngestedRequest,
    RecordIngestedResult,
    ReindexAnnRequest,
    ReindexAnnResult,
    SourceSnapshotItem,
)
from mistralai_capabilities.workflows import client as workflows_client
from worker.workflows.search import SearchReconcileWorkflow


class _FakeResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> Self:
        return self

    def all(self) -> list[Any]:
        return self._rows


class _FakeTx:
    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False


class _FakeSession:
    def __init__(self, rows: list[Any] | None = None) -> None:
        self._rows = rows or []
        self.by_pk: dict[tuple[str, str], Any] = {}

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False

    def begin(self) -> _FakeTx:
        return _FakeTx()

    async def execute(self, *_: object, **__: object) -> _FakeResult:
        return _FakeResult(self._rows)

    async def get(self, _model: object, pk: tuple[str, str]) -> Any:
        return self.by_pk.get(pk)

    def add(self, _obj: object) -> None:
        return None


def _maker(session: _FakeSession) -> Any:
    def factory() -> _FakeSession:
        return session

    return factory


def _row(source_key: str, *, size: int, etag: str | None = None) -> IngestionSourceState:
    return IngestionSourceState(
        collection_name="c",
        source_key=source_key,
        size=size,
        etag=etag,
        last_seen_at=datetime.now(UTC),
    )


def test_fingerprint_match_prefers_etag_then_mtime() -> None:
    now = datetime.now(UTC)
    etag_row = IngestionSourceState(collection_name="c", source_key="k", size=1, etag="e", last_seen_at=now)
    assert reconcile._fingerprint_match(etag_row, SourceSnapshotItem(source_key="k", size=1, etag="e")) is True
    assert reconcile._fingerprint_match(etag_row, SourceSnapshotItem(source_key="k", size=1, etag="e2")) is False
    mtime_row = IngestionSourceState(collection_name="c", source_key="k", size=1, mtime=now, last_seen_at=now)
    assert reconcile._fingerprint_match(mtime_row, SourceSnapshotItem(source_key="k", size=1, mtime=now)) is True
    bare_row = IngestionSourceState(collection_name="c", source_key="k", size=1, last_seen_at=now)
    assert reconcile._fingerprint_match(bare_row, SourceSnapshotItem(source_key="k", size=1)) is False


def test_reconcile_abort_reason_guards_mass_purge() -> None:
    assert reconcile_abort_reason(
        snapshot_count=0, existing_count=5, deleted_count=5, delete_threshold=0.5, dry_run=False
    )
    assert reconcile_abort_reason(
        snapshot_count=10, existing_count=10, deleted_count=9, delete_threshold=0.5, dry_run=False
    )
    assert (
        reconcile_abort_reason(
            snapshot_count=10, existing_count=10, deleted_count=9, delete_threshold=0.5, dry_run=True
        )
        is None
    )
    assert (
        reconcile_abort_reason(
            snapshot_count=10, existing_count=10, deleted_count=1, delete_threshold=0.5, dry_run=False
        )
        is None
    )
    assert (
        reconcile_abort_reason(snapshot_count=0, existing_count=0, deleted_count=0, delete_threshold=0.5, dry_run=False)
        is None
    )


@pytest.mark.asyncio
async def test_reconcile_plan_classifies(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [_row("a", size=10, etag="e1"), _row("b", size=20, etag="e2"), _row("d", size=1, etag="e4")]
    monkeypatch.setattr(reconcile, "get_session_maker", lambda: _maker(_FakeSession(rows)))
    snapshot = [
        SourceSnapshotItem(source_key="a", size=10, etag="e1"),
        SourceSnapshotItem(source_key="b", size=20, etag="e2-new"),
        SourceSnapshotItem(source_key="c", size=5, etag="e3"),
    ]
    plan = await reconcile.search_reconcile_plan(
        ReconcilePlanRequest(collection_name="c", run_id="r", snapshot=snapshot)
    )
    actions = {item.source_key: item.action for item in plan.items}
    assert actions == {"a": "unchanged", "b": "updated", "c": "new", "d": "deleted"}
    assert plan.snapshot_count == 3
    assert plan.existing_count == 3
    assert plan.deleted_count == 1


@pytest.mark.asyncio
async def test_delete_keys_on_canonical_doc_id(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeStore:
        def __init__(self) -> None:
            self.deleted: list[str] = []

        async def delete_document(self, doc_id: str) -> None:
            self.deleted.append(doc_id)

    store = _FakeStore()
    monkeypatch.setattr(reconcile, "_open_store", lambda _name: store)
    monkeypatch.setattr(reconcile, "get_session_maker", lambda: _maker(_FakeSession()))
    result = await reconcile.search_delete(DeleteRequest(collection_name="c", source_keys=["k1", "k2"], run_id="r"))
    assert store.deleted == [compute_id("k1"), compute_id("k2")]
    assert result.deleted == 2
    assert result.failed == 0


def _upserted_rows(statement: Any) -> list[dict[str, Any]]:
    """Reassemble the rows a multi-row INSERT will send, from its compiled bind parameters.

    SQLAlchemy names them ``<column>_m<row index>``, so this is the values the database sees rather
    than a re-reading of what the test just passed in.
    """
    rows: dict[int, dict[str, Any]] = {}
    for key, value in statement.compile().params.items():
        column, _, index = key.rpartition("_m")
        rows.setdefault(int(index), {})[column] = value
    return [rows[index] for index in sorted(rows)]


@pytest.mark.asyncio
async def test_record_ingested_fingerprints_only_what_the_wave_indexed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The manifest is the "do not re-ingest" record, so a failed source must not enter it.

    The staged pipeline reports failures rather than successes, so this activity records the
    complement — get that backwards and a source the index never received is skipped forever.

    One statement for the whole wave, not one per source: the wave is the documented unit of
    manifest recording, and a session per source would serialize the fan-out that just ran
    concurrently.
    """
    executed: list[Any] = []

    class _RecordingSession(_FakeSession):
        async def execute(self, statement: Any, *_: object, **__: object) -> _FakeResult:
            executed.append(statement)
            return _FakeResult([])

    monkeypatch.setattr(reconcile, "get_session_maker", lambda: _maker(_RecordingSession()))
    result = await reconcile.search_record_ingested(
        RecordIngestedRequest(
            collection_name="c",
            run_id="r",
            items=[
                ReconcileItem(source_key="a", action="new", size=1, etag="e1"),
                ReconcileItem(source_key="b", action="updated", size=2, etag="e2"),
                ReconcileItem(source_key="c", action="new", size=3, etag="e3"),
            ],
            failed_source_keys=["c"],
        )
    )

    assert len(executed) == 1
    rows = _upserted_rows(executed[0])
    assert [row["source_key"] for row in rows] == ["a", "b"]
    assert [row["etag"] for row in rows] == ["e1", "e2"]
    assert all(row["run_id"] == "r" and row["deleted_at"] is None for row in rows)
    assert (result.created, result.updated, result.failed) == (1, 1, 1)


@pytest.mark.asyncio
async def test_record_ingested_writes_nothing_when_the_whole_wave_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty complement must not open a transaction, and must still count the failures."""
    executed: list[Any] = []

    class _RecordingSession(_FakeSession):
        async def execute(self, statement: Any, *_: object, **__: object) -> _FakeResult:
            executed.append(statement)
            return _FakeResult([])

    monkeypatch.setattr(reconcile, "get_session_maker", lambda: _maker(_RecordingSession()))
    result = await reconcile.search_record_ingested(
        RecordIngestedRequest(
            collection_name="c",
            run_id="r",
            items=[ReconcileItem(source_key="a", action="new", size=1)],
            failed_source_keys=["a"],
        )
    )

    assert executed == []
    assert (result.created, result.updated, result.failed) == (0, 0, 1)


def _http_error(status: int) -> MistralError:
    error = MistralError.__new__(MistralError)
    Exception.__init__(error, f"status {status}")
    object.__setattr__(error, "status_code", status)
    return error


class _FakeSchedules:
    def __init__(self, *, create_fails: bool = False, update_fails: bool = False) -> None:
        self._create_fails = create_fails
        self._update_fails = update_fails
        self.created: list[dict[str, Any]] = []
        self.updated: list[dict[str, Any]] = []
        self.get_calls = 0

    async def get_schedule_async(self, **_: Any) -> Any:
        self.get_calls += 1
        return {"ok": True}

    async def schedule_workflow_async(self, **kwargs: Any) -> Any:
        if self._create_fails:
            raise _http_error(500)
        # Build the model the SDK would build, so a cross-family mix-up fails here rather
        # than passing a test and then raising ValidationError on a real deploy.
        WorkflowScheduleRequest(
            schedule=kwargs["schedule"],
            workflow_identifier=kwargs.get("workflow_identifier"),
            deployment_name=kwargs.get("deployment_name"),
        )
        self.created.append(kwargs)
        return {"schedule_id": kwargs["schedule"].schedule_id}

    async def update_schedule_async(self, **kwargs: Any) -> Any:
        if self._update_fails:
            raise _http_error(500)
        self.updated.append(kwargs)
        return {"schedule_id": kwargs.get("schedule_id")}


def _fake_client(schedules: _FakeSchedules) -> Any:
    workflows_ns = type("_W", (), {"schedules": schedules})()
    return type("_C", (), {"workflows": workflows_ns})()


@pytest.mark.asyncio
async def test_upsert_schedule_creates_with_a_stable_id(monkeypatch: pytest.MonkeyPatch) -> None:
    schedules = _FakeSchedules()
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: _fake_client(schedules))
    await workflows_client.upsert_schedule(
        schedule_id="sched-x",
        workflow_identifier="search_reconcile",
        interval_seconds=3600,
        input={"collection_name": "c"},
    )
    assert len(schedules.created) == 1
    assert schedules.updated == []
    assert schedules.created[0]["workflow_identifier"] == "search_reconcile"
    schedule = schedules.created[0]["schedule"]
    assert schedule.schedule_id == "sched-x"
    assert schedule.policy.overlap == ScheduleOverlapPolicy.SKIP
    assert schedule.intervals[0].every == "PT3600S"


@pytest.mark.asyncio
async def test_upsert_schedule_does_not_probe_before_creating(monkeypatch: pytest.MonkeyPatch) -> None:
    # The platform's create handler already resolves an existing id to an update.
    schedules = _FakeSchedules()
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: _fake_client(schedules))
    await workflows_client.upsert_schedule(
        schedule_id="sched-x", workflow_identifier="search_reconcile", interval_seconds=7200, input={}
    )
    assert schedules.get_calls == 0


@pytest.mark.asyncio
async def test_upsert_schedule_updates_when_create_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    schedules = _FakeSchedules(create_fails=True)
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: _fake_client(schedules))
    await workflows_client.upsert_schedule(
        schedule_id="sched-x", workflow_identifier="search_reconcile", interval_seconds=3600, input={}
    )
    assert schedules.created == []
    assert len(schedules.updated) == 1
    assert schedules.updated[0]["schedule_id"] == "sched-x"
    assert schedules.updated[0]["schedule"].intervals[0].every == "PT3600S"


@pytest.mark.asyncio
async def test_upsert_schedule_propagates_when_the_fallback_also_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # A real auth/validation fault fails both calls, so it must surface rather than be swallowed.
    schedules = _FakeSchedules(create_fails=True, update_fails=True)
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: _fake_client(schedules))
    with pytest.raises(MistralError):
        await workflows_client.upsert_schedule(
            schedule_id="sched-x", workflow_identifier="search_reconcile", interval_seconds=3600, input={}
        )
    assert schedules.created == []
    assert schedules.updated == []


@pytest.mark.parametrize("error", [SourceNotFoundError("gone"), DocumentNotFoundError("gone")])
@pytest.mark.asyncio
async def test_delete_notfound_still_tombstones(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    class _MissingStore:
        async def delete_document(self, _doc_id: str) -> None:
            raise error

    row = _row("k1", size=1)
    session = _FakeSession()
    session.by_pk[("c", "k1")] = row
    monkeypatch.setattr(reconcile, "_open_store", lambda _name: _MissingStore())
    monkeypatch.setattr(reconcile, "get_session_maker", lambda: _maker(session))
    result = await reconcile.search_delete(DeleteRequest(collection_name="c", source_keys=["k1"], run_id="r"))
    assert result.deleted == 1
    assert result.failed == 0
    assert row.deleted_at is not None


@pytest.mark.asyncio
async def test_reconcile_settings_resolves_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(reconcile.ingestion_env, "ingestion_delete_threshold", 0.3)
    monkeypatch.setattr(reconcile.ingestion_env, "ingestion_batch_size", 7)
    monkeypatch.setattr(reconcile.ingestion_env, "ingestion_tombstone_gc_days", 5)
    monkeypatch.setattr(reconcile.ingestion_env, "ingestion_dry_run", False)
    settings = await reconcile.search_reconcile_settings(ReconcileRequest(collection_name="c"))
    assert (settings.delete_threshold, settings.batch_size, settings.tombstone_gc_days, settings.dry_run) == (
        0.3,
        7,
        5,
        False,
    )
    forced = await reconcile.search_reconcile_settings(ReconcileRequest(collection_name="c", dry_run=True))
    assert forced.dry_run is True


@pytest.mark.asyncio
async def test_enumerate_skips_long_keys_and_dirs(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeStorage:
        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *_: object) -> bool:
            return False

        async def list_objects(self, *, prefix: str | None = None) -> list[ObjectMetadata]:
            return [
                ObjectMetadata(key="ok.txt", size=3),
                ObjectMetadata(key="nested/", size=0),
                ObjectMetadata(key="x" * 300, size=5),
            ]

    monkeypatch.setattr(reconcile, "_open_object_storage", lambda: _FakeStorage())
    result = await reconcile.search_enumerate(EnumerateRequest())
    assert {item.source_key for item in result.items} == {"ok.txt"}


def _as_result(raw: Any) -> ReconcileResult:
    return raw if isinstance(raw, ReconcileResult) else ReconcileResult.model_validate(raw)


class _SweepSpy:
    """Records what the reconcile sweep asked for: ANN rebuilds, and each manifest wave."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.recorded: list[list[str]] = []

    async def __call__(self, request: ReindexAnnRequest) -> ReindexAnnResult:
        self.calls.append(request.collection_name)
        return ReindexAnnResult(reindexed=True)


def _stub_reconcile_pass(
    monkeypatch: pytest.MonkeyPatch,
    *,
    actions: list[str],
    dry_run: bool = False,
    batch_failures: list[str] | None = None,
    unroutable: list[str] | None = None,
    max_concurrent_batches: int = 10,
    batch_size: int = 10,
) -> _SweepSpy:
    from mistralai.workflows import workflow as wf_module

    monkeypatch.setattr(wf_module, "uuid4", lambda: "00000000-0000-0000-0000-000000000000")

    items = [ReconcileItem(source_key=f"k{index}", action=action) for index, action in enumerate(actions)]

    async def _settings(_request: Any) -> ReconcileSettings:
        return ReconcileSettings(
            delete_threshold=0.9,
            batch_size=batch_size,
            max_concurrent_batches=max_concurrent_batches,
            tombstone_gc_days=0,
            dry_run=dry_run,
        )

    async def _enumerate(_request: Any) -> EnumerateResult:
        return EnumerateResult(items=[])

    async def _plan(_request: Any) -> ReconcilePlan:
        return ReconcilePlan(
            collection_name="c",
            run_id="r",
            items=items,
            snapshot_count=len(items),
            existing_count=len(items),
            deleted_count=sum(1 for item in items if item.action == "deleted"),
        )

    async def _ensure(_request: Any) -> None:
        return None

    async def _execute_workflow(_workflow: Any, params: Any, **_kwargs: Any) -> IngestDocumentsOutput:
        # Stands in for `IngestDocumentsWorkflow`, which folds unroutable references into the same
        # failure list the stages report — the workflow under test sees only that list.
        unroutable_keys, failed_keys = set(unroutable or []), set(batch_failures or [])
        failures = [
            DocumentFailure(source_id=ref.source_id, stage="route", message="no pipeline")
            for ref in params.refs
            if ref.source_id in unroutable_keys
        ] + [
            DocumentFailure(source_id=ref.source_id, stage="extract", message="boom")
            for ref in params.refs
            if ref.source_id in failed_keys
        ]
        return IngestDocumentsOutput(
            total_documents=len(params.refs),
            indexed_documents=len(params.refs) - len(failures),
            indexed_chunks=0,
            failures=failures,
        )

    async def _record(request: Any) -> RecordIngestedResult:
        # Mirrors the activity's own rule so the workflow's counting is what is under test.
        failed = set(request.failed_source_keys)
        kept = [item for item in request.items if item.source_key not in failed]
        spy.recorded.append([item.source_key for item in kept])
        return RecordIngestedResult(
            created=sum(1 for item in kept if item.action == "new"),
            updated=sum(1 for item in kept if item.action != "new"),
            failed=len(request.items) - len(kept),
        )

    async def _delete(request: Any) -> DeleteResult:
        return DeleteResult(collection_name="c", deleted=len(request.source_keys))

    spy = _SweepSpy()
    monkeypatch.setattr(reconcile, "search_reconcile_settings", _settings)
    monkeypatch.setattr(reconcile, "search_enumerate", _enumerate)
    monkeypatch.setattr(reconcile, "search_reconcile_plan", _plan)
    monkeypatch.setattr(reconcile, "search_ensure_collection", _ensure)
    monkeypatch.setattr(reconcile, "search_record_ingested", _record)
    monkeypatch.setattr(reconcile, "search_delete", _delete)
    monkeypatch.setattr(reconcile, "search_reindex_ann", spy)
    monkeypatch.setattr(workflow_module, "execute_workflow", _execute_workflow)
    return spy


async def test_reconcile_rebuilds_the_ann_index_after_writing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Writes degrade the diskann graph, so a sweep that wrote must rebuild it.

    Without this call, rows ingested into an existing index answer top-10 at a fraction of
    the recall a rebuilt index gives, worse than the sequential scan the index replaced.
    This test stops the call being deleted.
    """
    spy = _stub_reconcile_pass(monkeypatch, actions=["new", "updated"])

    result = _as_result(await SearchReconcileWorkflow().run(ReconcileRequest(collection_name="c")))

    assert (result.created, result.updated) == (1, 1)
    assert spy.calls == ["c"]


async def test_reconcile_skips_the_rebuild_when_nothing_changed(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _stub_reconcile_pass(monkeypatch, actions=["unchanged"])

    result = _as_result(await SearchReconcileWorkflow().run(ReconcileRequest(collection_name="c")))

    assert result.created == 0
    assert spy.calls == []


async def test_reconcile_dry_run_never_rebuilds(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _stub_reconcile_pass(monkeypatch, actions=["new"], dry_run=True)

    result = _as_result(await SearchReconcileWorkflow().run(ReconcileRequest(collection_name="c")))

    assert result.dry_run is True
    assert spy.calls == []


async def test_reconcile_records_the_manifest_once_per_wave(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each wave of batch children is fingerprinted before the next one starts.

    The manifest is what stops the next sweep re-ingesting a source, so waiting until the whole
    corpus finished would make an interrupted pass redo every source it had already indexed.
    """
    spy = _stub_reconcile_pass(
        monkeypatch,
        actions=["new"] * 4,
        batch_size=1,
        max_concurrent_batches=2,
    )

    result = _as_result(await SearchReconcileWorkflow().run(ReconcileRequest(collection_name="c")))

    assert spy.recorded == [["k0", "k1"], ["k2", "k3"]]
    assert result.created == 4


async def test_reconcile_never_fingerprints_a_source_a_stage_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A source the pipeline could not index must stay unrecorded, so the next sweep retries it."""
    spy = _stub_reconcile_pass(monkeypatch, actions=["new", "new"], batch_failures=["k1"])

    result = _as_result(await SearchReconcileWorkflow().run(ReconcileRequest(collection_name="c")))

    assert spy.recorded == [["k0"]]
    assert (result.created, result.failed) == (1, 1)


async def test_reconcile_counts_unroutable_sources_as_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A source no pipeline claims never reaches a batch, so only the plan can account for it."""
    spy = _stub_reconcile_pass(monkeypatch, actions=["new", "new"], unroutable=["k0"])

    result = _as_result(await SearchReconcileWorkflow().run(ReconcileRequest(collection_name="c")))

    assert spy.recorded == [["k1"]]
    assert (result.created, result.failed) == (1, 1)


async def test_ensure_collection_rejects_an_embed_model_the_pipelines_do_not_use(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The collection is sized from the request, but every pipeline embeds with the setting.

    Unchecked, a run naming ``mistral-embed-dim256-2510`` against a ``dim128`` deployment creates a
    256-wide collection and then indexes 128-wide vectors into it — postgres rejects that on the
    config row, the local backend accepts it and answers with a corpus half of which is
    unsearchable. The activity must refuse before it opens the store.

    Driven through ``with_scoped_dependencies`` rather than by passing a registry in, because the
    SDK strips a ``Depends`` parameter from the activity's call signature: this is the only way the
    worker ever reaches it, and it also asserts the provider is registered at all. The registry it
    yields is left empty, so a build that dropped the model check would raise ``UnknownRouterError``
    on the next line instead and fail this test.
    """
    monkeypatch.setattr(reconcile, "register_search_pipelines", lambda *_: None)
    monkeypatch.setattr(reconcile.ingestion_env, "ingestion_embed_model", "mistral-embed-dim128-2510")
    monkeypatch.setattr(
        reconcile, "_open_store", lambda name: pytest.fail(f"opened store {name!r} despite the mismatch")
    )
    injector = DependencyInjector.get_singleton_instance()

    async with injector.with_scoped_dependencies({reconcile.ingestion_pipelines}):
        with pytest.raises(CollectionConfigMismatchError, match="mistral-embed-dim256-2510"):
            await reconcile.search_ensure_collection(
                EnsureCollectionRequest(collection_name="c", embed_model="mistral-embed-dim256-2510")
            )
