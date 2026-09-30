"""Execution ownership is an authorization boundary, so pin its shape and its query.

An execution id travels in a URL, so it is a direct object reference. The ``WHERE`` clause of
``is_owned_by`` is exactly what a caller must satisfy; these tests read that clause. No async driver
or Postgres is available here, so the accessor's statement is observed through a recording stand-in.

A rendered statement only proves what was *sent*. Whether Postgres accepts it — notably whether an
``ON CONFLICT`` target can be resolved to a real index — is pinned by
``test_workflow_executions_pg.py`` against a live server.
"""

import inspect
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from db.accessors import workflow_executions
from db.accessors.workflow_executions import (
    discard_execution,
    is_owned_by,
    list_owned,
    outcomes,
    owned_ids,
    record_execution,
    reserve_execution,
    set_outcome,
)
from db.models.workflow import WorkflowExecution
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ClauseElement
from sqlmodel import SQLModel


class _Scalars:
    def __init__(self, rows: list[str]) -> None:
        self._rows = rows

    def all(self) -> list[str]:
        return self._rows


class _Result:
    def __init__(self, scalar: str | None, rows: list[str] | None = None) -> None:
        self._scalar = scalar
        self._rows = rows or []

    def scalar_one_or_none(self) -> str | None:
        return self._scalar

    def scalar_one(self) -> str | None:
        return self._scalar

    def scalars(self) -> _Scalars:
        return _Scalars(self._rows)


class RecordingSession:
    """The slice of ``AsyncSession`` the accessors touch, keeping every call for inspection."""

    def __init__(self, scalar: str | None = None, rows: list[str] | None = None) -> None:
        self.added: list[Any] = []
        self.statements: list[ClauseElement] = []
        self.commits = 0
        self._scalar = scalar
        self._rows = rows or []

    def add(self, instance: Any) -> None:
        self.added.append(instance)

    async def commit(self) -> None:
        self.commits += 1

    async def execute(self, statement: ClauseElement, *args: Any, **kwargs: Any) -> _Result:
        self.statements.append(statement)
        return _Result(self._scalar, self._rows)

    def as_session(self) -> AsyncSession:
        return cast(AsyncSession, self)


def _rendered(statement: ClauseElement) -> str:
    return str(statement.compile(compile_kwargs={"literal_binds": True}))


def test_the_table_is_named_for_workflows_not_for_agents() -> None:
    """The table serves every workflow, so nothing about it may still say ``agent``."""
    assert WorkflowExecution.__tablename__ == "workflow_executions"
    assert "workflow_executions" in SQLModel.metadata.tables
    assert "agent_executions" not in SQLModel.metadata.tables


def test_workflow_name_is_a_required_indexed_column() -> None:
    """Required, because a row with no discriminator is a row that answers for every workflow."""
    column = SQLModel.metadata.tables["workflow_executions"].columns["workflow_name"]

    assert column.nullable is False
    assert column.type.compile(postgresql.dialect()) == "VARCHAR(255)"
    assert column.index is True


def test_user_id_is_indexed_and_deliberately_not_a_foreign_key() -> None:
    """``user_id`` is the Keycloak ``sub``, not ``users.id``; that looseness is intentional."""
    table = SQLModel.metadata.tables["workflow_executions"]

    assert table.columns["user_id"].index is True
    assert table.columns["user_id"].foreign_keys == set()
    assert table.primary_key.columns.keys() == ["execution_id"]


async def test_record_execution_stages_all_three_owner_facts() -> None:
    """The workflow name is written at create time, or the check can never be scoped by it."""
    session = RecordingSession()

    execution = await record_execution(
        session.as_session(), execution_id="exec-1", user_id="kc-sub-1", workflow_name="agents"
    )

    assert session.added == [execution]
    assert session.commits == 1
    assert (execution.execution_id, execution.user_id, execution.workflow_name) == ("exec-1", "kc-sub-1", "agents")
    assert execution.created_at.tzinfo is not None


async def test_is_owned_by_constrains_the_execution_the_caller_and_the_workflow() -> None:
    """All three together: any two of them is a hole rather than a check.

    Execution plus caller would let someone who owns an agents execution address it through a
    speech router; execution plus workflow would drop the owner entirely.
    """
    session = RecordingSession(scalar="exec-1")

    owned = await is_owned_by(session.as_session(), execution_id="exec-1", user_id="kc-sub-1", workflow_name="agents")

    assert owned is True
    sql = _rendered(session.statements[0])
    assert "workflow_executions.execution_id = 'exec-1'" in sql
    assert "workflow_executions.user_id = 'kc-sub-1'" in sql
    assert "workflow_executions.workflow_name = 'agents'" in sql


async def test_is_owned_by_reports_a_miss_as_false_rather_than_raising() -> None:
    """A miss is the ordinary case — an unknown id — and the route turns it into a 404."""
    session = RecordingSession(scalar=None)

    owned = await is_owned_by(session.as_session(), execution_id="exec-1", user_id="kc-sub-1", workflow_name="speech")

    assert owned is False


@pytest.mark.parametrize("name", ["record_execution", "is_owned_by"])
def test_the_accessors_take_their_three_strings_by_keyword(name: str) -> None:
    """Three same-typed strings in a row: positional calls would transpose them silently."""
    parameters = list(inspect.signature(getattr(workflow_executions, name)).parameters.values())

    assert parameters[0].name == "session"
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in parameters[1:])
    assert {p.name for p in parameters[1:]} == {"execution_id", "user_id", "workflow_name"}


class _SequencedSession:
    """A session whose ``execute`` returns a scripted scalar per call, for the two-statement path."""

    def __init__(self, scalars: list[str | None]) -> None:
        self._scalars = list(scalars)
        self.statements: list[ClauseElement] = []
        self.commits = 0

    def add(self, instance: Any) -> None:  # pragma: no cover - reserve stages nothing
        raise AssertionError("reserve_execution issues statements, it does not stage instances")

    async def commit(self) -> None:
        self.commits += 1

    async def execute(self, statement: ClauseElement, *args: Any, **kwargs: Any) -> _Result:
        self.statements.append(statement)
        return _Result(self._scalars.pop(0))

    def as_session(self) -> AsyncSession:
        return cast(AsyncSession, self)


def _rendered_pg(statement: ClauseElement) -> str:
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def test_idempotency_key_is_an_optional_column() -> None:
    """It is only set when a caller supplies the header, so most rows leave it NULL."""
    column = SQLModel.metadata.tables["workflow_executions"].columns["idempotency_key"]

    assert column.nullable is True
    assert column.type.compile(postgresql.dialect()) == "VARCHAR(255)"


async def test_reserve_execution_claims_the_key_atomically_and_returns_the_winning_id() -> None:
    """One statement decides the winner: INSERT ... ON CONFLICT DO NOTHING RETURNING the id."""
    session = RecordingSession(scalar="exec-new")

    won = await reserve_execution(
        session.as_session(), execution_id="exec-new", user_id="kc-1", workflow_name="agents", idempotency_key="k1"
    )

    assert won == "exec-new"
    assert session.commits == 1
    assert len(session.statements) == 1, "the winner is decided in one statement, no separate lookup"
    sql = _rendered_pg(session.statements[0]).upper()
    # The predicate is load-bearing: the arbiter index is partial, and Postgres refuses to infer a
    # partial index unless the statement repeats its WHERE. Dropping it makes every idempotent
    # create fail with "no unique or exclusion constraint matching the ON CONFLICT specification".
    assert "ON CONFLICT (USER_ID, WORKFLOW_NAME, IDEMPOTENCY_KEY) WHERE IDEMPOTENCY_KEY IS NOT NULL DO NOTHING" in sql
    assert "RETURNING WORKFLOW_EXECUTIONS.EXECUTION_ID" in sql


async def test_reserve_execution_returns_the_existing_id_when_the_key_was_already_claimed() -> None:
    """A conflict yields no returned row, so the existing execution is read back and handed over."""
    session = _SequencedSession([None, "exec-first"])

    won = await reserve_execution(
        session.as_session(), execution_id="exec-second", user_id="kc-1", workflow_name="agents", idempotency_key="k1"
    )

    assert won == "exec-first"
    assert len(session.statements) == 2, "insert missed, then the existing row is selected"
    lookup = _rendered_pg(session.statements[1])
    assert "workflow_executions.user_id = 'kc-1'" in lookup
    assert "workflow_executions.workflow_name = 'agents'" in lookup
    assert "workflow_executions.idempotency_key = 'k1'" in lookup


def test_reserve_execution_takes_its_arguments_by_keyword() -> None:
    """Four same-typed strings now: a positional call would transpose them silently."""
    parameters = list(inspect.signature(reserve_execution).parameters.values())

    assert parameters[0].name == "session"
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in parameters[1:])
    assert {p.name for p in parameters[1:]} == {"execution_id", "user_id", "workflow_name", "idempotency_key"}


# --- the listing, the batch check and the compensating delete -----------------------------------


async def test_owned_ids_answers_the_whole_batch_in_one_scoped_statement() -> None:
    """One statement, and still scoped by the full triple — a batch is not a weaker check."""
    session = RecordingSession(rows=["exec-1", "exec-2"])

    owned = await owned_ids(
        session.as_session(), execution_ids=["exec-1", "exec-2", "exec-3"], user_id="kc-1", workflow_name="agents"
    )

    assert owned == {"exec-1", "exec-2"}
    assert len(session.statements) == 1, "the point of this accessor is that it asks once"
    sql = _rendered(session.statements[0])
    assert "workflow_executions.execution_id IN ('exec-1', 'exec-2', 'exec-3')" in sql
    assert "workflow_executions.user_id = 'kc-1'" in sql
    assert "workflow_executions.workflow_name = 'agents'" in sql


async def test_list_owned_is_scoped_to_the_caller_and_ordered_newest_first() -> None:
    """The listing's authorization is this WHERE clause; nothing downstream re-checks it."""
    session = RecordingSession(rows=["exec-2", "exec-1"])

    page = await list_owned(session.as_session(), user_id="kc-1", workflow_name="agents", limit=20)

    assert page == ["exec-2", "exec-1"]
    sql = _rendered(session.statements[0])
    assert "workflow_executions.user_id = 'kc-1'" in sql
    assert "workflow_executions.workflow_name = 'agents'" in sql
    assert "ORDER BY workflow_executions.created_at DESC, workflow_executions.execution_id DESC" in sql
    assert "LIMIT 20" in sql


async def test_list_owned_seeks_past_the_cursor_row_without_trusting_it() -> None:
    """The cursor is resolved through the same triple, so a foreign id resolves to NULL and pages nothing."""
    session = RecordingSession(rows=[])

    await list_owned(session.as_session(), user_id="kc-1", workflow_name="agents", limit=20, after_id="exec-9")

    sql = _rendered(session.statements[0])
    assert "(workflow_executions.created_at, workflow_executions.execution_id) <" in sql
    assert sql.count("workflow_executions.user_id = 'kc-1'") == 2, "the cursor subquery is scoped too"
    assert "workflow_executions.execution_id = 'exec-9'" in sql


async def test_list_owned_bounds_the_window_on_created_at() -> None:
    """`start_time_*` maps onto creation time, which is the only clock this table has."""
    session = RecordingSession(rows=[])

    await list_owned(
        session.as_session(),
        user_id="kc-1",
        workflow_name="agents",
        limit=5,
        created_after=datetime(2024, 1, 1, tzinfo=UTC),
        created_before=datetime(2024, 2, 1, tzinfo=UTC),
    )

    sql = _rendered(session.statements[0])
    assert "workflow_executions.created_at >=" in sql
    assert "workflow_executions.created_at <=" in sql


async def test_discard_execution_deletes_only_the_callers_own_row() -> None:
    """Scoped by the triple like every other access: a claim is only ever withdrawn by its owner."""
    session = RecordingSession()

    await discard_execution(session.as_session(), execution_id="exec-1", user_id="kc-1", workflow_name="agents")

    assert session.commits == 1
    sql = _rendered(session.statements[0])
    assert sql.startswith("DELETE FROM workflow_executions")
    assert "workflow_executions.execution_id = 'exec-1'" in sql
    assert "workflow_executions.user_id = 'kc-1'" in sql
    assert "workflow_executions.workflow_name = 'agents'" in sql


def test_the_new_accessors_take_their_arguments_by_keyword() -> None:
    for accessor in (owned_ids, list_owned, discard_execution):
        parameters = list(inspect.signature(accessor).parameters.values())
        assert parameters[0].name == "session"
        assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in parameters[1:]), accessor.__name__


# --- the outcome badge, scoped by (execution_id, user_id) ----------------------------------------


class _RowSession:
    """A session whose ``execute`` answers ``.all()`` with scripted ``(id, outcome)`` rows."""

    def __init__(self, *, scalar: str | None = None, rows: list[tuple[str, str]] | None = None) -> None:
        self.statements: list[ClauseElement] = []
        self.commits = 0
        self._scalar = scalar
        self._rows = rows or []

    async def commit(self) -> None:
        self.commits += 1

    async def execute(self, statement: ClauseElement, *args: Any, **kwargs: Any) -> Any:
        self.statements.append(statement)
        rows, scalar = self._rows, self._scalar

        class _R:
            def all(self) -> list[tuple[str, str]]:
                return rows

            def scalar_one_or_none(self) -> str | None:
                return scalar

        return _R()

    def as_session(self) -> AsyncSession:
        return cast(AsyncSession, self)


async def test_set_outcome_is_scoped_to_the_owner_and_writes_only_when_unset() -> None:
    """First writer wins and the write is bounded by the caller: UPDATE ... WHERE user_id AND IS NULL."""
    session = _RowSession(scalar="exec-1")

    won = await set_outcome(session.as_session(), execution_id="exec-1", user_id="kc-1", outcome="approved")

    assert won is True
    assert session.commits == 1
    sql = _rendered(session.statements[0])
    assert sql.startswith("UPDATE workflow_executions SET outcome=")
    assert "workflow_executions.execution_id = 'exec-1'" in sql
    assert "workflow_executions.user_id = 'kc-1'" in sql
    assert "workflow_executions.outcome IS NULL" in sql, "first writer wins is the IS NULL guard"


async def test_set_outcome_reports_a_miss_as_false() -> None:
    """No row updated — already settled OR not the caller's — is a False the caller cannot tell apart."""
    session = _RowSession(scalar=None)

    won = await set_outcome(session.as_session(), execution_id="exec-1", user_id="kc-1", outcome="approved")

    assert won is False


async def test_set_outcome_is_not_scoped_by_workflow_name() -> None:
    """The primary key already selects the row, so the discriminator that guards is_owned_by is absent."""
    session = _RowSession(scalar="exec-1")

    await set_outcome(session.as_session(), execution_id="exec-1", user_id="kc-1", outcome="rejected")

    assert "workflow_name" not in _rendered(session.statements[0])


async def test_outcomes_reads_owned_settled_ids_in_one_scoped_statement() -> None:
    """One statement, scoped by the owner, and only rows that actually carry an outcome."""
    session = _RowSession(rows=[("exec-1", "approved"), ("exec-2", "rejected")])

    settled = await outcomes(session.as_session(), execution_ids=["exec-1", "exec-2", "exec-3"], user_id="kc-1")

    assert settled == {"exec-1": "approved", "exec-2": "rejected"}
    assert len(session.statements) == 1
    sql = _rendered(session.statements[0])
    assert "workflow_executions.execution_id IN ('exec-1', 'exec-2', 'exec-3')" in sql
    assert "workflow_executions.user_id = 'kc-1'" in sql
    assert "workflow_executions.outcome IS NOT NULL" in sql, "a still-open row is simply absent"


def test_the_outcome_accessors_take_their_arguments_by_keyword() -> None:
    for accessor in (set_outcome, outcomes):
        parameters = list(inspect.signature(accessor).parameters.values())
        assert parameters[0].name == "session"
        assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in parameters[1:]), accessor.__name__
