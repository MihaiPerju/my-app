"""Accessor for the ``users`` table.

Kept in the ``db`` package (persistence) so the API host stays free of ORM
queries. ``upsert_user`` is idempotent: it creates the caller on first sight and
refreshes the mutable identity fields on subsequent requests.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from db.models.user import User


async def get_user_by_user_id(session: AsyncSession, user_id: str) -> User | None:
    result = await session.execute(select(User).where(col(User.user_id) == user_id))
    return result.scalar_one_or_none()


async def upsert_user(session: AsyncSession, *, user_id: str, email: str | None = None) -> User:
    """Create the caller on first sight, refresh their mutable fields thereafter.

    One ``INSERT ... ON CONFLICT DO UPDATE ... RETURNING`` instead of a read followed by a write.
    This runs on the auth path of every request, so the round trips matter. A read-then-write also
    races itself: two concurrent first requests from the same caller both see no row, both insert,
    and one loses to the ``user_id`` unique constraint, which returns a 500 when a new user arrives.
    """
    now = datetime.now(UTC)
    statement = pg_insert(User).values(
        id=uuid.uuid4(),
        user_id=user_id,
        email=email,
        is_active=True,
        created_at=now,
        updated_at=now,
        last_seen_at=now,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["user_id"],
        set_={
            "updated_at": now,
            "last_seen_at": now,
            # COALESCE, not a plain overwrite: `email` is an optional claim, so a token
            # that omits it must not blank an address we already know.
            "email": func.coalesce(statement.excluded.email, col(User.email)),
        },
    )
    result = await session.execute(statement.returning(User), execution_options={"populate_existing": True})
    user = result.scalar_one()
    await session.commit()
    return user
