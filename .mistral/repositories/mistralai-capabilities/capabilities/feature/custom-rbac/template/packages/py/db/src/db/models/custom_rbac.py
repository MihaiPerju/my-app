"""RBAC tables: principals, teams, and their per-resource grants.

A grant is ``(dimension, value, write)``: read access to a value of a dimension, plus
whether the caller may also write it. One grant shape drives both page visibility
(the ``page`` pseudo-dimension) and per-dimension data scoping (the app's dimensions).

Grants attach to a ``Team``; a ``Principal`` gets them by ``TeamMembership``, and a
caller's effective permission is the union across their teams. The per-principal
``Grant`` table predates teams and is still honoured (unioned in), so teams are an
additive layer with no destructive migration. ``is_admin`` on the principal is the
bypass (full read/write + manage access). Tables are prefixed ``rbac_`` to share a
database without name clashes.

These table and column names are a compatibility surface shared with the apps adopting this
capability. The case-folding unique indexes (``lower(email)`` / ``lower(name)``) are stricter than
their legacy plain unique ones, so an adopter stamps ``custom_rbac_0001`` and swaps those indexes (see the
capability's INSTALL.md).
"""

from __future__ import annotations

from sqlalchemy import Index, UniqueConstraint, text
from sqlmodel import Field, SQLModel


class Principal(SQLModel, table=True):
    """A user, keyed on the SSO email the gateway forwards. ``is_admin`` bypasses every
    check (full read/write + the admin panel). Email casing is preserved for display, but the
    unique index folds case (``lower(email)``): authorization resolves with ``lower(email)``, so
    ``user@x`` and ``User@x`` must never be two principals with divergent grants."""

    __tablename__ = "rbac_principals"
    __table_args__ = (Index("ix_rbac_principals_email", text("lower(email)"), unique=True),)

    id: int | None = Field(default=None, primary_key=True)
    email: str
    name: str = ""
    is_admin: bool = False


class Grant(SQLModel, table=True):
    """One permission for a principal: read access to ``value`` of ``dimension``, plus
    ``write`` for write access too (write always implies read, since a write grant is a
    grant). Unique per (principal, dimension, value) so grants are idempotent."""

    __tablename__ = "rbac_grants"
    __table_args__ = (UniqueConstraint("principal_id", "dimension", "value", name="uq_grant"),)

    id: int | None = Field(default=None, primary_key=True)
    principal_id: int = Field(foreign_key="rbac_principals.id", index=True)
    dimension: str = Field(index=True)
    value: str
    write: bool = False


class Team(SQLModel, table=True):
    """A named group permissions attach to. Users join via ``TeamMembership`` and inherit the
    team's grants. Membership is always explicit: a principal joins a team only when added to it.
    The unique index folds case (``lower(name)``) so ``Finance`` and ``finance`` cannot both be
    created."""

    __tablename__ = "rbac_teams"
    __table_args__ = (Index("ix_rbac_teams_name", text("lower(name)"), unique=True),)

    id: int | None = Field(default=None, primary_key=True)
    name: str


class TeamMembership(SQLModel, table=True):
    """A principal's membership in a team. Unique per (principal, team) so joining is
    idempotent; a caller's permissions are the union over their memberships."""

    __tablename__ = "rbac_team_memberships"
    __table_args__ = (UniqueConstraint("principal_id", "team_id", name="uq_team_member"),)

    id: int | None = Field(default=None, primary_key=True)
    principal_id: int = Field(foreign_key="rbac_principals.id", index=True)
    team_id: int = Field(foreign_key="rbac_teams.id", index=True)


class TeamGrant(SQLModel, table=True):
    """One permission for a team: read access to ``value`` of ``dimension``, plus
    ``write`` for write access too (write implies read). Same shape as ``Grant`` but
    owned by a team; unique per (team, dimension, value) so grants are idempotent."""

    __tablename__ = "rbac_team_grants"
    __table_args__ = (UniqueConstraint("team_id", "dimension", "value", name="uq_team_grant"),)

    id: int | None = Field(default=None, primary_key=True)
    team_id: int = Field(foreign_key="rbac_teams.id", index=True)
    dimension: str = Field(index=True)
    value: str
    write: bool = False
