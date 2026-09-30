"""The caller row the gate upserts, as an interface it can be handed.

Reached as a FastAPI dependency, so a test swaps it with ``dependency_overrides`` and the host
installs the concrete store (production uses ``mistralai_capabilities.fastapi_auth.stores.PostgresUserStore``).
The identity layer names this Protocol and the caller shape (``identity.user.User``) but imports no
persistence, so the delivery runtime carries no ``db`` dependency.
"""

from typing import Annotated, Protocol

from fastapi import Depends

from mistralai_capabilities.fastapi_auth.identity.user import User


class UserStore(Protocol):
    async def upsert(self, *, user_id: str, email: str | None) -> User: ...


def _user_store() -> UserStore:
    # The host must install a concrete store (see apps/api `create_app`). Raising here, rather than
    # defaulting to Postgres, is what keeps `db` out of the delivery layer's import graph: a
    # forgotten wire fails loudly at first use instead of silently pulling persistence into the runtime.
    raise RuntimeError(
        "no UserStore installed: the host must override `_user_store` "
        "(e.g. with mistralai_capabilities.fastapi_auth.stores.PostgresUserStore)"
    )


Users = Annotated[UserStore, Depends(_user_store)]
