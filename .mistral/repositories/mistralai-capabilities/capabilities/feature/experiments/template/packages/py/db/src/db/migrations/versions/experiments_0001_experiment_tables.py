"""experiment tables

Revision ID: experiments_0001
Revises: — (standalone branch)
Create Date: 2026-09-25

Creates the five experiment-framework tables: ``artifact``, ``experiment``,
``active_experiment``, ``experiment_artifact``, and ``experiment_result``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
import sqlmodel.sql.sqltypes
from alembic import op

revision: str = "experiments_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = ("experiments",)
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "artifact",
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=256), nullable=False),
        sa.Column("hash", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("type", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=False),
        sa.Column("scope", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("name"),
    )
    op.create_table(
        "experiment",
        sa.Column("feature", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("definition_hash", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("feature", "name"),
    )
    op.create_table(
        "active_experiment",
        sa.Column("feature", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("promoted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("promoted_by", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=True),
        sa.ForeignKeyConstraint(
            ["feature", "name"],
            ["experiment.feature", "experiment.name"],
            name="fk_active_experiment_experiment",
        ),
        sa.PrimaryKeyConstraint("feature"),
    )
    op.create_table(
        "experiment_artifact",
        sa.Column("feature", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("artifact_name", sa.String(length=256), nullable=False),
        sa.ForeignKeyConstraint(["artifact_name"], ["artifact.name"]),
        sa.ForeignKeyConstraint(
            ["feature", "name"],
            ["experiment.feature", "experiment.name"],
            name="fk_experiment_artifact_experiment",
        ),
        sa.PrimaryKeyConstraint("feature", "name", "artifact_name", name="pk_experiment_artifact"),
    )
    op.create_index("ix_experiment_artifact_name", "experiment_artifact", ["artifact_name"], unique=False)
    op.create_table(
        "experiment_result",
        sa.Column("id", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("feature", sqlmodel.sql.sqltypes.AutoString(length=32), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("dataset", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("scores", sa.JSON(), nullable=False),
        sa.Column("studio_run_id", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=True),
        sa.Column("dataset_size", sa.Integer(), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column("run_id", sqlmodel.sql.sqltypes.AutoString(length=128), nullable=False),
        sa.Column("definition_hash", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["feature", "name"],
            ["experiment.feature", "experiment.name"],
            name="fk_experiment_result_experiment",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_experiment_result_created", "experiment_result", ["feature", "created_at"], unique=False)
    op.create_index("ix_experiment_result_experiment", "experiment_result", ["feature", "name"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_experiment_result_experiment", table_name="experiment_result")
    op.drop_index("ix_experiment_result_created", table_name="experiment_result")
    op.drop_table("experiment_result")
    op.drop_index("ix_experiment_artifact_name", table_name="experiment_artifact")
    op.drop_table("experiment_artifact")
    op.drop_table("active_experiment")
    op.drop_table("experiment")
    op.drop_table("artifact")
