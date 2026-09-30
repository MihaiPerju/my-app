"""Host wiring: the Postgres user store bound onto the delivery runtime's Protocol seam.

The rest of ``mistralai_capabilities.fastapi_auth`` declares ``UserStore`` as a Protocol (see
``identity.store``) and imports no ``db``. This module is the one place that names a concrete
implementation, so it is the only part of the capability that reaches into ``db``. That keeps the
dependency one-way (``fastapi_auth -> db``) and the graph acyclic. Importing it pulls in ``db``, so it
is host-side wiring only: never import it from the rest of the delivery layer, and never from a worker.
"""

from db import get_session_maker
from db.accessors.users import upsert_user
from db.models.user import User
from fastapi import FastAPI

from mistralai_capabilities.fastapi_auth.identity.store import _user_store

__all__ = ["PostgresUserStore", "install_user_store"]


class PostgresUserStore:
    async def upsert(self, *, user_id: str, email: str | None) -> User:
        async with get_session_maker()() as session:
            return await upsert_user(session, user_id=user_id, email=email)


def install_user_store(app: FastAPI) -> None:
    """Wire the Postgres user store onto ``app`` in one call.

    Uses the same ``dependency_overrides`` seam tests use, applied once at app construction. The
    store is installed because the delivery layer imports no ``db``: ``_user_store`` raises until the
    host binds a concrete implementation here.
    """
    app.dependency_overrides[_user_store] = PostgresUserStore
