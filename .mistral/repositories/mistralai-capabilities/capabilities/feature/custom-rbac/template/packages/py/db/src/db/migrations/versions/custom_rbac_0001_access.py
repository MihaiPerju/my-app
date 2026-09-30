"""custom-rbac baseline: principals, teams, and their per-dimension grants.

Shipped by the capability that owns the tables, beside its models (``db/models/custom_rbac.py``), so a
freshly generated app has the ``rbac_*`` tables after ``init-migrations`` with no ``db:revision``
step, and an app that never selects ``custom-rbac`` never sees the file. It is the root of its own branch
(``down_revision = None``, labelled ``custom_rbac``) rather than a link in a shared chain: which
capabilities own tables varies per composition, so no baseline may name another as its parent.

The columns and unique constraints match ``db/models/custom_rbac.py`` (and the schema already live in
adopting apps), so ``SQLModel.metadata.create_all`` stays a no-op on existing tables. Email and team
name fold case at the database boundary (``lower(...)`` functional unique indexes): authorization
resolves with the folded form, so two rows differing only in case would make it ambiguous.

Revision ID: custom_rbac_0001
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "custom_rbac_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = ("custom_rbac",)
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rbac_principals",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_rbac_principals_email", "rbac_principals", [sa.text("lower(email)")], unique=True)

    op.create_table(
        "rbac_grants",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("principal_id", sa.Integer(), nullable=False),
        sa.Column("dimension", sa.String(), nullable=False),
        sa.Column("value", sa.String(), nullable=False),
        sa.Column("write", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["principal_id"], ["rbac_principals.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("principal_id", "dimension", "value", name="uq_grant"),
    )
    op.create_index("ix_rbac_grants_principal_id", "rbac_grants", ["principal_id"])
    op.create_index("ix_rbac_grants_dimension", "rbac_grants", ["dimension"])

    op.create_table(
        "rbac_teams",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_rbac_teams_name", "rbac_teams", [sa.text("lower(name)")], unique=True)

    op.create_table(
        "rbac_team_memberships",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("principal_id", sa.Integer(), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["principal_id"], ["rbac_principals.id"]),
        sa.ForeignKeyConstraint(["team_id"], ["rbac_teams.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("principal_id", "team_id", name="uq_team_member"),
    )
    op.create_index("ix_rbac_team_memberships_principal_id", "rbac_team_memberships", ["principal_id"])
    op.create_index("ix_rbac_team_memberships_team_id", "rbac_team_memberships", ["team_id"])

    op.create_table(
        "rbac_team_grants",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("dimension", sa.String(), nullable=False),
        sa.Column("value", sa.String(), nullable=False),
        sa.Column("write", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["team_id"], ["rbac_teams.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("team_id", "dimension", "value", name="uq_team_grant"),
    )
    op.create_index("ix_rbac_team_grants_team_id", "rbac_team_grants", ["team_id"])
    op.create_index("ix_rbac_team_grants_dimension", "rbac_team_grants", ["dimension"])


def downgrade() -> None:
    op.drop_table("rbac_team_grants")
    op.drop_table("rbac_team_memberships")
    op.drop_table("rbac_teams")
    op.drop_table("rbac_grants")
    op.drop_table("rbac_principals")
