"""Ownership of workflow executions.

One row per execution started through the API. Execution ids are addressable in URLs, so every
access is checked against this table. Ownership is the triple, not the pair: ``workflow_name`` is
stored so an id the caller owns under one workflow cannot reach another workflow through a router.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index, text
from sqlmodel import Field, SQLModel

OWNER_RECENCY_INDEX = "ix_workflow_executions_owner_recency"
IDEMPOTENCY_KEY_INDEX = "uq_workflow_executions_idempotency_key"


class WorkflowExecution(SQLModel, table=True):
    __tablename__ = "workflow_executions"

    # The composite index makes a listing page a range scan; the single-column indexes serve the
    # ownership check, which ignores ``created_at``. The partial unique index (built by the
    # ``fastapi_workflows_auth_0001`` baseline) is declared here, not via Field(unique=True), so it
    # does not reject the NULL rows a keyless create leaves and alembic can diff it instead of
    # dropping it each run.
    __table_args__ = (
        Index(OWNER_RECENCY_INDEX, "user_id", "workflow_name", "created_at"),
        Index(
            IDEMPOTENCY_KEY_INDEX,
            "user_id",
            "workflow_name",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    execution_id: str = Field(primary_key=True, max_length=255)
    # No foreign key to ``users``: this is the Keycloak ``sub``, and the record has to
    # survive independently of whether the local user row has been upserted yet.
    user_id: str = Field(index=True, max_length=255)
    workflow_name: str = Field(index=True, max_length=255)
    # Uniqueness is scoped to ``(user_id, workflow_name, idempotency_key)``, never the key alone, so
    # one caller's key can never collide with another's. It is the partial unique index declared in
    # ``__table_args__`` above; the common create carries no key, leaves this NULL, and many NULL
    # rows must coexist.
    idempotency_key: str | None = Field(default=None, max_length=255)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False), default_factory=lambda: datetime.now(UTC)
    )
    # A denormalized copy of a run's terminal outcome, so the listing can badge it without a per-row
    # workflow query. Opaque here: the feature layer defines the label (Document Annotation UI's
    # review gate writes
    # "approved"/"rejected"), this table never interprets it and holds no enum or CHECK. NULL for a
    # run that never settles. Unindexed on purpose: it is only read alongside the owner predicate,
    # which the owner-recency index covers.
    outcome: str | None = Field(default=None, max_length=32)
