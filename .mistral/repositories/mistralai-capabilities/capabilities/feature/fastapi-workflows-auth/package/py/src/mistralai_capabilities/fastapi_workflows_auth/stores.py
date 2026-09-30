"""Host wiring: the Postgres execution store bound onto the delivery runtime's Protocol seam.

The rest of ``mistralai_capabilities.fastapi_workflows_auth`` declares ``ExecutionStore`` as a Protocol
(see ``ownership``) and imports no ``db``. This module is the one place that names a concrete
implementation, so it is the only part of the capability that reaches into ``db``. That keeps the
dependency one-way (``fastapi_workflows_auth -> db``) and the graph acyclic. Importing it pulls in ``db``,
so it is host-side wiring only: never import it from the rest of the delivery layer, and never from a
worker.
"""

from collections.abc import Sequence
from datetime import datetime

from db import get_session_maker
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
from fastapi import FastAPI
from mistralai_capabilities.fastapi_workflows_auth.commands import (
    _CLIENT_COMMANDS,
    ExecutionCommands,
    RetryingExecutionCommands,
    _commands,
)
from mistralai_capabilities.fastapi_workflows_auth.ownership import _executions

__all__ = ["PostgresExecutionStore", "install_execution_store"]


class PostgresExecutionStore:
    async def record(self, *, execution_id: str, user_id: str, workflow_name: str) -> None:
        async with get_session_maker()() as session:
            await record_execution(session, execution_id=execution_id, user_id=user_id, workflow_name=workflow_name)

    async def is_owned_by(self, *, execution_id: str, user_id: str, workflow_name: str) -> bool:
        async with get_session_maker()() as session:
            return await is_owned_by(session, execution_id=execution_id, user_id=user_id, workflow_name=workflow_name)

    async def owned_ids(self, *, execution_ids: Sequence[str], user_id: str, workflow_name: str) -> set[str]:
        async with get_session_maker()() as session:
            return await owned_ids(session, execution_ids=execution_ids, user_id=user_id, workflow_name=workflow_name)

    async def list_owned(
        self,
        *,
        user_id: str,
        workflow_name: str,
        limit: int,
        after_id: str | None = None,
        created_after: datetime | None = None,
        created_before: datetime | None = None,
    ) -> list[str]:
        async with get_session_maker()() as session:
            return await list_owned(
                session,
                user_id=user_id,
                workflow_name=workflow_name,
                limit=limit,
                after_id=after_id,
                created_after=created_after,
                created_before=created_before,
            )

    async def reserve_execution(
        self, *, execution_id: str, user_id: str, workflow_name: str, idempotency_key: str
    ) -> str:
        async with get_session_maker()() as session:
            return await reserve_execution(
                session,
                execution_id=execution_id,
                user_id=user_id,
                workflow_name=workflow_name,
                idempotency_key=idempotency_key,
            )

    async def discard(self, *, execution_id: str, user_id: str, workflow_name: str) -> None:
        async with get_session_maker()() as session:
            await discard_execution(session, execution_id=execution_id, user_id=user_id, workflow_name=workflow_name)

    async def set_outcome(self, *, execution_id: str, user_id: str, outcome: str) -> bool:
        async with get_session_maker()() as session:
            return await set_outcome(session, execution_id=execution_id, user_id=user_id, outcome=outcome)

    async def outcomes(self, *, execution_ids: Sequence[str], user_id: str) -> dict[str, str]:
        async with get_session_maker()() as session:
            return await outcomes(session, execution_ids=execution_ids, user_id=user_id)


def install_execution_store(app: FastAPI) -> None:
    """Wire the Postgres execution store and the retrying commands adapter onto ``app``.

    Uses the same ``dependency_overrides`` seam tests use, applied once at app construction. The
    store is installed because the delivery layer imports no ``db``. The retrying commands adapter is
    installed here, not defaulted, so ``_commands()`` stays the plain facade its identity test pins,
    and the transient-read retry is a host policy the delivery machinery does not assume.
    """
    app.dependency_overrides[_executions] = PostgresExecutionStore
    # Annotated, and built here rather than inside the lambda, so this line is where a type checker
    # sees the adapter against the Protocol. Otherwise an operation added to `ExecutionCommands` and
    # missed on the hand-written adapter would reach a route as an `AttributeError`. One instance,
    # like `_CLIENT_COMMANDS`, because it holds no state and resolves its inner facade per call.
    retrying_commands: ExecutionCommands = RetryingExecutionCommands(_CLIENT_COMMANDS)
    app.dependency_overrides[_commands] = lambda: retrying_commands
