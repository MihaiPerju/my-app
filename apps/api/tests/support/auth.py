from db.models.user import User
from fastapi import FastAPI
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.fastapi_auth.identity import (
    HEADER_USER_EMAIL,
    HEADER_USER_ID,
)
from mistralai_capabilities.fastapi_auth.identity.store import _user_store

USER_ID = "22222222-2222-2222-2222-222222222222"
EMAIL = "dev@mistral.ai"


def auth_headers(user_id: str = USER_ID, email: str | None = EMAIL) -> dict[str, str]:
    headers = {HEADER_USER_ID: user_id}
    if email is not None:
        headers[HEADER_USER_EMAIL] = email
    return headers


class FakeUserStore:
    def __init__(self) -> None:
        self.is_active = True
        self.seen: list[tuple[str, str | None]] = []

    async def upsert(self, *, user_id: str, email: str | None) -> User:
        self.seen.append((user_id, email))
        return User(user_id=user_id, email=email, is_active=self.is_active)


def auth_hooks(users: FakeUserStore) -> FastAPIHooks:
    def configure(app: FastAPI) -> None:
        app.dependency_overrides[_user_store] = lambda: users

    return FastAPIHooks(configure_hooks=(("auth", configure),))
