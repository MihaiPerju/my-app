"""Execution ownership: the persistence interface and the refusal it backs.

Every route that accepts an execution id re-checks ownership. Ownership is the whole triple,
workflow name included, so a caller cannot use an id owned under one workflow to address another.
The store is substitutable and is the only authority on ownership; the platform never learns which
end user started an execution. :func:`require_owned` is the refusal, a FastAPI dependency.
"""

from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime
from typing import Annotated, Protocol

from fastapi import Depends, HTTPException
from mistralai_capabilities.fastapi_auth.identity import CurrentUser

# The one phrase every ownership refusal uses. A distinct one per resource would tell a caller
# which check it tripped, which is the oracle the 404-not-403 convention exists to deny.
UNKNOWN_EXECUTION = "Unknown execution"


class ExecutionStore(Protocol):
    async def record(self, *, execution_id: str, user_id: str, workflow_name: str) -> None: ...

    async def is_owned_by(self, *, execution_id: str, user_id: str, workflow_name: str) -> bool: ...

    async def owned_ids(self, *, execution_ids: Sequence[str], user_id: str, workflow_name: str) -> set[str]:
        """Which of ``execution_ids`` this caller owns under this workflow, in one round trip.

        The batch routes need every id or none. One query with a set comparison keeps a
        hundred-id batch a single statement, instead of one :meth:`is_owned_by` query per id.
        """
        ...

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
        """One page of the caller's execution ids, newest first.

        ``after_id`` is the last id of the previous page and is the whole cursor. A foreign or
        unknown ``after_id`` yields an empty page, not an error, so it cannot probe for existence.
        """
        ...

    async def reserve_execution(
        self, *, execution_id: str, user_id: str, workflow_name: str, idempotency_key: str
    ) -> str:
        """Claim ``execution_id`` for ``idempotency_key``, or return the id already claimed for it.

        Records ownership and reserves the key in one atomic step. A return of this call's own
        ``execution_id`` must start the workflow; any other value is an earlier create's execution
        to hand back unchanged. Only invoked when the caller supplies an ``Idempotency-Key``.
        """
        ...

    async def discard(self, *, execution_id: str, user_id: str, workflow_name: str) -> None:
        """Undo a claim whose execution never started.

        For an idempotent create the reserved row carries the key, so without this a retry matches
        the reservation and gets an id that never started. Compensating keeps a failed create
        retryable. Applied to both paths, because one cleanup also stops keyless orphans.
        """
        ...

    async def set_outcome(self, *, execution_id: str, user_id: str, outcome: str) -> bool:
        """Record a run's first terminal outcome, returning whether this call set it.

        ``outcome`` is an opaque label the feature layer writes, denormalized so the listing reads
        it without a per-row workflow query. First writer wins: it returns ``True`` only when it
        moved the value from unset to ``outcome``. A row that is not the caller's is indistinguish-
        able from one already set, matching the 404-not-403 posture of this module.
        """
        ...

    async def outcomes(self, *, execution_ids: Sequence[str], user_id: str) -> dict[str, str]:
        """The recorded outcome for each of ``execution_ids`` that has one, in one round trip.

        Only ids the caller owns that carry an outcome appear; an unowned, unknown, or open id is
        absent. This lets the listing show a per-run badge for a page in one statement.
        """
        ...


def _executions() -> ExecutionStore:
    # The host must install a concrete store (see apps/api `create_app`). Raising here, rather than
    # defaulting to Postgres, keeps `db` out of `core/api`'s import graph, so a forgotten wire fails
    # loudly at first use.
    raise RuntimeError(
        "no ExecutionStore installed: the host must override `_executions` "
        "(e.g. with mistralai_capabilities.fastapi_workflows_auth.stores.PostgresExecutionStore)"
    )


Executions = Annotated[ExecutionStore, Depends(_executions)]


def require_owned(workflow_name: str) -> Callable[..., Awaitable[None]]:
    """The ownership check for one mount, as a dependency ``router._mounter`` attaches by path.

    A dependency, not a line in each endpoint body, so a route cannot drop the check. Raising from
    a dependency renders like a body 404, and for SSE routes it runs before the endpoint builds its
    ``StreamingResponse``. This is the single-workflow case of :func:`require_owned_any`.
    """

    return require_owned_any((workflow_name,))


def require_owned_any(workflow_names: tuple[str, ...]) -> Callable[..., Awaitable[None]]:
    """The ownership check against a set of workflows: owned under *any* of them passes.

    The loop both public checks share. Document Annotation UI review routes are shared across catalog workflows keyed
    by execution id, so ownership must accept any that could own the run. An empty tuple refuses
    every id.
    """

    async def owned(execution_id: str, executions: Executions, user: CurrentUser) -> None:
        for workflow_name in workflow_names:
            if await executions.is_owned_by(
                execution_id=execution_id, user_id=user.user_id, workflow_name=workflow_name
            ):
                return
        raise HTTPException(status_code=404, detail=UNKNOWN_EXECUTION)

    return owned
