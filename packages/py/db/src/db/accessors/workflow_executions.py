"""Accessors for the ``workflow_executions`` ownership table."""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import delete, literal, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from db.models.workflow import WorkflowExecution


async def record_execution(
    session: AsyncSession, *, execution_id: str, user_id: str, workflow_name: str
) -> WorkflowExecution:
    execution = WorkflowExecution(execution_id=execution_id, user_id=user_id, workflow_name=workflow_name)
    session.add(execution)
    await session.commit()
    return execution


async def reserve_execution(
    session: AsyncSession, *, execution_id: str, user_id: str, workflow_name: str, idempotency_key: str
) -> str:
    """Claim ``execution_id`` for ``idempotency_key``, or return the id already claimed for it.

    ``INSERT ... ON CONFLICT DO NOTHING RETURNING`` decides a concurrent double-submit in one
    statement: it returns this call's id when it won, nothing when a row already existed. The caller
    starts the workflow only when the returned id matches. ``created_at`` is supplied explicitly.

    ``index_where`` is required, not decorative: the arbiter is the *partial* unique index
    ``uq_workflow_executions_idempotency_key`` (``WHERE idempotency_key IS NOT NULL``), and Postgres
    only infers a partial index when the statement repeats its predicate. Without it the server
    rejects the whole statement with "there is no unique or exclusion constraint matching the ON
    CONFLICT specification", so every idempotent create fails.
    """
    statement = (
        pg_insert(WorkflowExecution)
        .values(
            execution_id=execution_id,
            user_id=user_id,
            workflow_name=workflow_name,
            idempotency_key=idempotency_key,
            created_at=datetime.now(UTC),
        )
        .on_conflict_do_nothing(
            index_elements=["user_id", "workflow_name", "idempotency_key"],
            index_where=col(WorkflowExecution.idempotency_key).is_not(None),
        )
        .returning(col(WorkflowExecution.execution_id))
    )
    won = (await session.execute(statement)).scalar_one_or_none()
    await session.commit()
    if won is not None:
        return won
    existing = await session.execute(
        select(WorkflowExecution.execution_id).where(
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.workflow_name) == workflow_name,
            col(WorkflowExecution.idempotency_key) == idempotency_key,
        )
    )
    return existing.scalar_one()


async def discard_execution(session: AsyncSession, *, execution_id: str, user_id: str, workflow_name: str) -> None:
    """Remove a claim whose execution never started.

    Scoped by the same triple every read is, so a caller can only ever withdraw its own claim.
    Deleting the row is what frees the ``idempotency_key`` it carries: leaving it behind would
    let a retry of that key match a reservation for an execution that does not exist.
    """
    await session.execute(
        delete(WorkflowExecution).where(
            col(WorkflowExecution.execution_id) == execution_id,
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.workflow_name) == workflow_name,
        )
    )
    await session.commit()


async def owned_ids(
    session: AsyncSession, *, execution_ids: Sequence[str], user_id: str, workflow_name: str
) -> set[str]:
    """Which of ``execution_ids`` the caller owns under this workflow, in one statement."""
    result = await session.execute(
        select(WorkflowExecution.execution_id).where(
            col(WorkflowExecution.execution_id).in_(list(execution_ids)),
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.workflow_name) == workflow_name,
        )
    )
    return set(result.scalars().all())


async def list_owned(
    session: AsyncSession,
    *,
    user_id: str,
    workflow_name: str,
    limit: int,
    after_id: str | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> list[str]:
    """One page of the caller's execution ids, newest first.

    Keyset, not offset: the sort is ``(created_at, execution_id)`` descending and a page resumes
    strictly below the previous row, so a mid-scan create cannot shift a row across a boundary. An
    ``after_id`` that is not the caller's yields an empty page, so paging cannot probe for an id.
    """
    statement = (
        select(WorkflowExecution.execution_id)
        .where(
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.workflow_name) == workflow_name,
        )
        .order_by(col(WorkflowExecution.created_at).desc(), col(WorkflowExecution.execution_id).desc())
        .limit(limit)
    )
    if created_after is not None:
        statement = statement.where(col(WorkflowExecution.created_at) >= created_after)
    if created_before is not None:
        statement = statement.where(col(WorkflowExecution.created_at) <= created_before)
    if after_id is not None:
        cursor = (
            select(WorkflowExecution.created_at)
            .where(
                col(WorkflowExecution.execution_id) == after_id,
                col(WorkflowExecution.user_id) == user_id,
                col(WorkflowExecution.workflow_name) == workflow_name,
            )
            .scalar_subquery()
        )
        statement = statement.where(
            tuple_(col(WorkflowExecution.created_at), col(WorkflowExecution.execution_id))
            < tuple_(cursor, literal(after_id))
        )
    result = await session.execute(statement)
    return list(result.scalars().all())


async def set_outcome(session: AsyncSession, *, execution_id: str, user_id: str, outcome: str) -> bool:
    """Record a run's first terminal outcome, atomically; return whether this call set it.

    First writer wins in one statement: the ``outcome IS NULL`` predicate means a second write for a
    settled run updates no row, so a race cannot flip a recorded outcome. Scoped by ``(execution_id,
    user_id)``. A hit returns ``execution_id``; a settled or foreign miss returns nothing (404-not-403).
    """
    statement = (
        update(WorkflowExecution)
        .where(
            col(WorkflowExecution.execution_id) == execution_id,
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.outcome).is_(None),
        )
        .values(outcome=outcome)
        .returning(col(WorkflowExecution.execution_id))
    )
    won = (await session.execute(statement)).scalar_one_or_none()
    await session.commit()
    return won is not None


async def outcomes(session: AsyncSession, *, execution_ids: Sequence[str], user_id: str) -> dict[str, str]:
    """The recorded outcome for each owned id that has one, in one statement.

    An id the caller does not own, or that carries no outcome yet, is simply absent from the map —
    the same "unowned and unknown are indistinguishable" property every read here keeps.
    """
    result = await session.execute(
        select(WorkflowExecution.execution_id, WorkflowExecution.outcome).where(
            col(WorkflowExecution.execution_id).in_(list(execution_ids)),
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.outcome).is_not(None),
        )
    )
    return {execution_id: value for execution_id, value in result.all() if value is not None}


async def is_owned_by(session: AsyncSession, *, execution_id: str, user_id: str, workflow_name: str) -> bool:
    """Ownership is the whole triple.

    Dropping ``workflow_name`` would make an id the caller owns under one workflow a valid
    key for another workflow's router, which is the direct-object-reference hole the column
    exists to close.
    """
    result = await session.execute(
        select(WorkflowExecution.execution_id).where(
            col(WorkflowExecution.execution_id) == execution_id,
            col(WorkflowExecution.user_id) == user_id,
            col(WorkflowExecution.workflow_name) == workflow_name,
        )
    )
    return result.scalar_one_or_none() is not None
