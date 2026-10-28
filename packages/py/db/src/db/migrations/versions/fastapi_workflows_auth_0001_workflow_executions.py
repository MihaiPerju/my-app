"""fastapi-workflows-auth baseline: the ``workflow_executions`` ownership table.

Shipped by the capability that owns the table, beside its model (``db/models/workflow.py``), so a
freshly generated app has the table after ``init-migrations`` with no ``db:revision`` step, and an
app without the integration never sees the file. It is the root of its own branch
(``down_revision = None``, labelled ``fastapi_workflows_auth``): which capabilities own tables varies
per composition, so no baseline may name another as its parent.

Revision ID: fastapi_workflows_auth_0001
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fastapi_workflows_auth_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = ("fastapi_workflows_auth",)
depends_on: str | Sequence[str] | None = None

OWNER_RECENCY_INDEX = "ix_workflow_executions_owner_recency"
IDEMPOTENCY_KEY_INDEX = "uq_workflow_executions_idempotency_key"


def upgrade() -> None:
    op.create_table(
        "workflow_executions",
        sa.Column("execution_id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("workflow_name", sa.String(length=255), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=True),
        sa.PrimaryKeyConstraint("execution_id"),
    )
    op.create_index(op.f("ix_workflow_executions_user_id"), "workflow_executions", ["user_id"], unique=False)
    op.create_index(
        op.f("ix_workflow_executions_workflow_name"), "workflow_executions", ["workflow_name"], unique=False
    )
    op.create_index(
        OWNER_RECENCY_INDEX, "workflow_executions", ["user_id", "workflow_name", "created_at"], unique=False
    )
    # Partial: only a request that supplied an Idempotency-Key reserves the triple, so the many
    # unkeyed executions (NULL key) never collide with each other.
    op.create_index(
        IDEMPOTENCY_KEY_INDEX,
        "workflow_executions",
        ["user_id", "workflow_name", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(IDEMPOTENCY_KEY_INDEX, table_name="workflow_executions")
    op.drop_index(OWNER_RECENCY_INDEX, table_name="workflow_executions")
    op.drop_index(op.f("ix_workflow_executions_workflow_name"), table_name="workflow_executions")
    op.drop_index(op.f("ix_workflow_executions_user_id"), table_name="workflow_executions")
    op.drop_table("workflow_executions")
