"""fastapi-auth baseline: the ``users`` table behind the gateway-identity user store.

Shipped by the capability that owns the table, beside its model (``db/models/user.py``), so a
freshly generated app has the table after ``init-migrations`` with no ``db:revision`` step, and an
app that never selects ``fastapi-auth`` never sees the file. It is the root of its own branch
(``down_revision = None``, labelled ``fastapi_auth``) rather than a link in a shared chain: which
capabilities own tables varies per composition, so no baseline may name another as its parent.

Revision ID: fastapi_auth_0001
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fastapi_auth_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = ("fastapi_auth",)
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_users_user_id"), "users", ["user_id"], unique=True)


def downgrade() -> None:
    op.drop_index(op.f("ix_users_user_id"), table_name="users")
    op.drop_table("users")
