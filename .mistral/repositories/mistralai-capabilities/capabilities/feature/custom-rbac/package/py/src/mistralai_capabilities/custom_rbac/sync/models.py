"""RBAC tables (sync adoption variant): principals, teams, and their per-resource grants.

A grant is ``(dimension, value, write)``: read access to a value of a dimension, plus whether the
caller may also write it. One grant shape drives both page visibility (the ``page`` pseudo-dimension)
and per-dimension data scoping (the app's dimensions). Grants attach to a ``Team``; a ``Principal``
gets them by ``TeamMembership``, and a caller's effective permission is the union across their teams.
The per-principal ``Grant`` table predates teams and is still honoured (unioned in), so teams are an
additive layer with no destructive migration. ``is_admin`` on the principal is the bypass.

This is the variant a **sync hexagonal app** adopts to REPLACE its own in-repo ``rbac_*`` models.
The table names, columns and unique constraints match the schema already live in those apps EXACTLY
(plain ``unique=True`` on email/name, ``uq_grant``/``uq_team_member``/``uq_team_grant``), so
``metadata.create_all`` is a no-op on existing tables and adoption needs no data migration. The
greenfield async ``postgres`` stack uses the ``template`` models (functional ``lower()`` unique
index); this module deliberately mirrors the deployed apps instead.

These map onto this module's OWN ``metadata``, not the shared ``SQLModel.metadata``: a published
package must not register ``rbac_*`` on every importer's global metadata, or it collides with an app
that already maps those names (the async ``template`` ``db.models`` do, which is exactly the clash a
consumer that imports both would hit). Adopters create the tables with ``metadata.create_all(engine)``
(re-exported from the ``sync`` package).
"""

from __future__ import annotations

from sqlalchemy import MetaData, UniqueConstraint
from sqlalchemy.orm import registry
from sqlmodel import Field, SQLModel

# Own MetaData/registry so these ``table=True`` models never land on the shared ``SQLModel.metadata``
# and clash with an app that also maps ``rbac_*`` (the async ``template`` db.models do). ``_SyncModel``
# carries both, so every table below is created only by this module's ``metadata.create_all``.
metadata = MetaData()
_registry = registry(metadata=metadata)


class _SyncModel(SQLModel, registry=_registry):
    metadata = metadata


class Principal(_SyncModel, table=True):
    """A user, keyed on the SSO email the gateway forwards. ``is_admin`` bypasses every check
    (full read/write + the admin panel)."""

    __tablename__ = "rbac_principals"

    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(unique=True, index=True)
    name: str = ""
    is_admin: bool = False


class Grant(_SyncModel, table=True):
    """One permission for a principal: read access to ``value`` of ``dimension``, plus ``write`` for
    write access too (write always implies read, since a write grant is a grant). Unique per
    (principal, dimension, value) so grants are idempotent."""

    __tablename__ = "rbac_grants"
    __table_args__ = (
        UniqueConstraint("principal_id", "dimension", "value", name="uq_grant"),
    )

    id: int | None = Field(default=None, primary_key=True)
    principal_id: int = Field(foreign_key="rbac_principals.id", index=True)
    dimension: str = Field(index=True)
    value: str
    write: bool = False


class Team(_SyncModel, table=True):
    """A named group permissions attach to. Users join via ``TeamMembership`` and inherit the team's
    grants. Membership is always explicit: a principal joins a team only when added to it."""

    __tablename__ = "rbac_teams"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)


class TeamMembership(_SyncModel, table=True):
    """A principal's membership in a team. Unique per (principal, team) so joining is idempotent; a
    caller's permissions are the union over their memberships."""

    __tablename__ = "rbac_team_memberships"
    __table_args__ = (
        UniqueConstraint("principal_id", "team_id", name="uq_team_member"),
    )

    id: int | None = Field(default=None, primary_key=True)
    principal_id: int = Field(foreign_key="rbac_principals.id", index=True)
    team_id: int = Field(foreign_key="rbac_teams.id", index=True)


class TeamGrant(_SyncModel, table=True):
    """One permission for a team: read access to ``value`` of ``dimension``, plus ``write`` for write
    access too (write implies read). Same shape as ``Grant`` but owned by a team; unique per
    (team, dimension, value) so grants are idempotent."""

    __tablename__ = "rbac_team_grants"
    __table_args__ = (
        UniqueConstraint("team_id", "dimension", "value", name="uq_team_grant"),
    )

    id: int | None = Field(default=None, primary_key=True)
    team_id: int = Field(foreign_key="rbac_teams.id", index=True)
    dimension: str = Field(index=True)
    value: str
    write: bool = False
