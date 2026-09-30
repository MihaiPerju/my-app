"""``reserve_execution`` against a live Postgres, because rendered SQL cannot prove acceptance.

The sibling suite renders the accessor's statement through a recording stand-in. That pins the text
but not the server's verdict, and the two came apart once already: the idempotency arbiter is a
*partial* unique index, Postgres will not infer one unless the statement repeats its predicate, and
the mocked test happily asserted the predicate-less string while every idempotent create 500'd.

Anything that depends on the planner resolving a conflict target belongs here, not there.

Runs under the same gate as the other contract suites — ``RUN_PG_CONTRACT=1`` plus a reachable
``DATABASE_URL`` (``bunx nx run db:test-pg-contract``); skipped otherwise.
"""

import os
from collections.abc import AsyncIterator

import pytest
from db.accessors.workflow_executions import reserve_execution
from db.models.workflow import WorkflowExecution
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

pytestmark = pytest.mark.skipif(not os.getenv("RUN_PG_CONTRACT"), reason="RUN_PG_CONTRACT is not set")

_TABLE = WorkflowExecution.__table__  # type: ignore[attr-defined]


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    """A session over a freshly created ``workflow_executions``, dropped again on the way out.

    The table is built from the model's own metadata, so the partial unique index under test is the
    one the application declares rather than a copy restated here.
    """
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.begin() as connection:
        await connection.run_sync(SQLModel.metadata.drop_all, tables=[_TABLE])
        await connection.run_sync(SQLModel.metadata.create_all, tables=[_TABLE])
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as opened:
            yield opened
        async with engine.begin() as connection:
            await connection.run_sync(SQLModel.metadata.drop_all, tables=[_TABLE])
    finally:
        await engine.dispose()


async def test_a_double_submit_of_one_key_yields_a_single_execution(session: AsyncSession) -> None:
    """The first caller's id wins and the second caller is handed that same id, not its own."""
    won = await reserve_execution(
        session, execution_id="exec-first", user_id="kc-1", workflow_name="agents", idempotency_key="k1"
    )
    assert won == "exec-first"

    replayed = await reserve_execution(
        session, execution_id="exec-second", user_id="kc-1", workflow_name="agents", idempotency_key="k1"
    )
    assert replayed == "exec-first", "the losing submit must adopt the winner's execution, not start a second one"


async def test_the_same_key_under_a_different_owner_is_a_separate_claim(session: AsyncSession) -> None:
    """The index is keyed on (user_id, workflow_name, idempotency_key), so tenants cannot collide."""
    mine = await reserve_execution(
        session, execution_id="exec-mine", user_id="kc-1", workflow_name="agents", idempotency_key="shared"
    )
    theirs = await reserve_execution(
        session, execution_id="exec-theirs", user_id="kc-2", workflow_name="agents", idempotency_key="shared"
    )

    assert (mine, theirs) == ("exec-mine", "exec-theirs")
