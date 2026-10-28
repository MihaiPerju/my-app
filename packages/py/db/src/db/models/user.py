"""User identity table, populated from the identity the gateway asserted.

One row per caller, keyed by ``user_id`` (the Keycloak ``sub``). The APISIX gateway injects it on
``x-user-id`` after authentication; the API has no auth middleware, so it upserts the row
(``identity.require_user``) and refuses an inactive one. ``user_id`` is trustworthy only because the
gateway strips any client copy and the API is unreachable except through it.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: str = Field(index=True, unique=True, max_length=255)
    email: str | None = Field(default=None, max_length=320)
    is_active: bool = True
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False), default_factory=lambda: datetime.now(UTC)
    )
    updated_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False), default_factory=lambda: datetime.now(UTC)
    )
    last_seen_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False), default_factory=lambda: datetime.now(UTC)
    )
