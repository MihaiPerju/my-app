"""Write access to the RBAC store (async): the admin matrix the panel drives.

Async SQLModel/SQLAlchemy over the app's ``db`` async session maker (asyncpg), operating on the
``rbac_*`` tables this capability contributes to the app's ``db`` package - the same way the
``postgres`` capability's stores use ``db``. The read side (``resolve_access``), which the
``AccessPolicy`` calls on every request, lives in ``resolve``.

Nothing here is domain-specific: the dimension vocabulary is the caller's, and value
canonicalization is an injected ``normalize`` hook (default: strip), so an app that needs
e.g. upper-cased codes on some dimension supplies one without this module knowing its
dimensions. Identity uniqueness (email, team name) is enforced case-insensitively: a folded
pre-check plus the database's functional unique index, so a duplicate raises a typed error the
API maps to 422 rather than persisting an ambiguous second row.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass

from db import get_session_maker
from db.models.custom_rbac import Grant, Principal, Team, TeamGrant, TeamMembership
from sqlalchemy import ColumnElement, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

#: Canonicalize a grant value for a dimension. Default: trim. An app injects its own (e.g.
#: upper-case a code dimension) so the stored value matches what enforcement compares against.
Normalizer = Callable[[str, str], str]


def _strip(value: str, dimension: str) -> str:
    return value.strip()


def _email_name_match(cleaned: str) -> ColumnElement[bool]:
    """Case-insensitive substring match on email OR name, for the directory search and the paged
    admin matrix. ``autoescape`` so a literal ``%``/``_`` in the query is a substring match, not a
    wildcard. The caller passes an already-stripped, lower-cased needle."""
    return or_(
        func.lower(Principal.email).contains(cleaned, autoescape=True),
        func.lower(Principal.name).contains(cleaned, autoescape=True),
    )


def _team_name_match(cleaned: str) -> ColumnElement[bool]:
    """Case-insensitive substring match on team name, for the paged team matrix. ``autoescape`` so a
    literal ``%``/``_`` is a substring match, not a wildcard. The caller passes an already-stripped,
    lower-cased needle."""
    return func.lower(Team.name).contains(cleaned, autoescape=True)


class DuplicatePrincipalError(ValueError):
    """A principal with the same email (case-insensitively) already exists."""


class DuplicateTeamError(ValueError):
    """A team with the same name (case-insensitively) already exists."""


def _tokens(pairs: Iterable[tuple[str, bool]]) -> tuple[str, ...]:
    return tuple(sorted(f"{value}:w" if write else value for value, write in pairs))


@dataclass(frozen=True, slots=True)
class GrantsReplaced:
    """A committed whole-section replace: the dimension's grants before and after, as sorted
    ``value`` / ``value:w`` tokens read under the owner's row lock in the writing transaction, so an
    audit record describes exactly what this write changed. Truthy, so ``if not replaced`` still
    reads as "unknown owner" (``None``)."""

    before: tuple[str, ...]
    after: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class MembersChanged:
    """A committed membership edit: the principal ids it actually added and removed, read in the
    writing transaction, so an audit record never reports a no-op or a dropped id as a change. Truthy,
    so ``if not changed`` still reads as "unknown team or user" (``None``)."""

    added: tuple[int, ...] = ()
    removed: tuple[int, ...] = ()


class LastAdminError(ValueError):
    """The change would leave no administrator, locking everyone out of the admin API."""


async def _lock_admin_ids(s: AsyncSession) -> set[int]:
    """Lock every admin row (in id order, so concurrent callers never deadlock) and return their ids,
    so a demotion or deletion checks and applies the "at least one admin" invariant atomically."""
    stmt = select(Principal.id).where(col(Principal.is_admin)).order_by(Principal.id).with_for_update()
    return set((await s.execute(stmt)).scalars().all())


@dataclass(frozen=True, slots=True)
class RbacStore:
    """The admin matrix: principals, teams, and their read/write grants. Async SQLModel on the
    app's session maker. ``normalize`` canonicalizes grant values per dimension (default: strip)."""

    normalize: Normalizer = _strip

    # --- principals ---------------------------------------------------------
    async def list_principals(self) -> list[Principal]:
        async with get_session_maker()() as s:
            result = await s.execute(select(Principal).order_by(Principal.email))
            return list(result.scalars().all())

    async def get_principal(self, principal_id: int) -> Principal | None:
        async with get_session_maker()() as s:
            return await s.get(Principal, principal_id)

    async def principals_by_emails(self, emails: Iterable[str]) -> list[Principal]:
        """The principals whose email case-insensitively matches one of ``emails``, resolved in SQL
        so a lookup of a few addresses never loads the whole tenant."""
        folded = {e.strip().lower() for e in emails if e.strip()}
        if not folded:
            return []
        async with get_session_maker()() as s:
            stmt = select(Principal).where(func.lower(Principal.email).in_(folded))
            return list((await s.execute(stmt)).scalars().all())

    async def search_principals(self, needle: str, limit: int) -> list[Principal]:
        """Case-insensitive email/name search, ordered and capped in SQL so a large workspace
        never loads every principal to filter in Python (the directory picker's query)."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = select(Principal)
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            stmt = stmt.order_by(Principal.email).limit(limit)
            return list((await s.execute(stmt)).scalars().all())

    async def count_principals(self, needle: str = "") -> int:
        """Count principals matching the (optional) email/name search - the ``total`` of the paged
        admin matrix, so the panel can render page controls without loading the whole tenant."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = select(func.count()).select_from(Principal)
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            return int((await s.execute(stmt)).scalar_one())

    async def page_principals(self, *, needle: str, limit: int, offset: int) -> list[Principal]:
        """One page of principals (email order), filtered by the same case-insensitive email/name
        search as the directory. The admin matrix pages through these so a request never scales with
        the whole tenant; pair with ``count_principals`` for the total."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = select(Principal)
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            stmt = stmt.order_by(Principal.email).limit(limit).offset(offset)
            return list((await s.execute(stmt)).scalars().all())

    async def admin_emails(self) -> frozenset[str]:
        """The emails of admin principals. Useful to exclude operator/test activity from usage
        analytics: admins bypass access, so their activity is noise."""
        async with get_session_maker()() as s:
            result = await s.execute(select(Principal.email).where(col(Principal.is_admin)))
            return frozenset(result.scalars().all())

    async def create_principal(
        self, *, email: str, name: str, is_admin: bool = False
    ) -> Principal:
        """Create a principal, rejecting a case-insensitive duplicate email atomically (folded
        pre-check plus the functional unique index) so no ambiguous second row is ever written. A
        new principal joins no team: team membership is always explicit."""
        canonical = email.strip()
        async with get_session_maker()() as s:
            clash = (
                await s.execute(select(Principal).where(func.lower(Principal.email) == canonical.lower()))
            ).scalars().first()
            if clash is not None:
                raise DuplicatePrincipalError(canonical)
            principal = Principal(email=canonical, name=name, is_admin=is_admin)
            s.add(principal)
            try:
                await s.commit()
            except IntegrityError as exc:
                await s.rollback()
                raise DuplicatePrincipalError(canonical) from exc
            await s.refresh(principal)
            return principal

    async def set_admin(self, principal_id: int, is_admin: bool) -> Principal | None:
        """Set the admin flag. Raises ``LastAdminError`` rather than demote the only admin."""
        async with get_session_maker()() as s:
            if not is_admin and await _lock_admin_ids(s) == {principal_id}:
                raise LastAdminError(principal_id)
            principal = await s.get(Principal, principal_id, with_for_update=True)
            if principal is None:
                return None
            principal.is_admin = is_admin
            s.add(principal)
            await s.commit()
            await s.refresh(principal)
            return principal

    async def delete_principal(self, principal_id: int) -> bool:
        """Delete a principal with its grants and memberships. Raises ``LastAdminError`` rather than
        delete the only admin. The row lock serializes against concurrent grant/membership writes
        (which lock or share-lock the principal), so none can insert a row pointing at it mid-delete."""
        async with get_session_maker()() as s:
            if await _lock_admin_ids(s) == {principal_id}:
                raise LastAdminError(principal_id)
            principal = await s.get(Principal, principal_id, with_for_update=True)
            if principal is None:
                return False
            grants = (await s.execute(select(Grant).where(Grant.principal_id == principal_id))).scalars().all()
            members = (
                await s.execute(select(TeamMembership).where(TeamMembership.principal_id == principal_id))
            ).scalars().all()
            for row in (*grants, *members):
                await s.delete(row)
            await s.flush()  # emit child DELETEs before the principal, or the FK rejects the delete
            await s.delete(principal)
            await s.commit()
            return True

    # --- grants (the read/write matrix) -------------------------------------
    async def list_grants(self, principal_id: int) -> list[Grant]:
        async with get_session_maker()() as s:
            result = await s.execute(select(Grant).where(Grant.principal_id == principal_id))
            return list(result.scalars().all())

    async def grants_by_principal(self) -> dict[int, list[Grant]]:
        """Every grant grouped by principal, in one query - so listing the matrix costs a fixed
        number of round trips instead of one per principal."""
        async with get_session_maker()() as s:
            rows = (await s.execute(select(Grant))).scalars().all()
        grouped: dict[int, list[Grant]] = {}
        for grant in rows:
            grouped.setdefault(grant.principal_id, []).append(grant)
        return grouped

    async def grants_by_principals(self, principal_ids: Sequence[int]) -> dict[int, list[Grant]]:
        """Grants grouped by principal, constrained to the given ids (the current matrix page), so the
        admin matrix reads only the page's grants instead of every grant in the tenant."""
        if not principal_ids:
            return {}
        async with get_session_maker()() as s:
            rows = (
                await s.execute(select(Grant).where(col(Grant.principal_id).in_(principal_ids)))
            ).scalars().all()
        grouped: dict[int, list[Grant]] = {}
        for grant in rows:
            grouped.setdefault(grant.principal_id, []).append(grant)
        return grouped

    async def _replace_grants(
        self,
        s: AsyncSession,
        *,
        grant_model: type[Grant] | type[TeamGrant],
        fk_name: str,
        owner_id: int,
        dimension: str,
        values_write: Mapping[str, bool],
    ) -> GrantsReplaced:
        """Delete-then-insert one dimension's grants for an owner within an open session - the shared
        primitive behind the per-user and per-team matrix saves. The DELETEs flush before the INSERTs
        (SQLAlchemy emits inserts first in one flush, which would collide with a not-yet-deleted row
        on the unique constraint); values are normalized then deduped (write wins) so two entries that
        canonicalize to the same value collapse to one row."""
        owner_col = getattr(grant_model, fk_name)
        existing = (
            await s.execute(select(grant_model).where(owner_col == owner_id, grant_model.dimension == dimension))
        ).scalars().all()
        before = _tokens((grant.value, grant.write) for grant in existing)
        for grant in existing:
            await s.delete(grant)
        await s.flush()
        collapsed: dict[str, bool] = {}
        for raw_value, can_write in values_write.items():
            value = self.normalize(raw_value, dimension)
            if value:
                collapsed[value] = collapsed.get(value, False) or can_write
        for value, can_write in collapsed.items():
            s.add(grant_model(**{fk_name: owner_id, "dimension": dimension, "value": value, "write": can_write}))
        return GrantsReplaced(before=before, after=_tokens(collapsed.items()))

    async def replace_grants(
        self, principal_id: int, dimension: str, values_write: Mapping[str, bool]
    ) -> GrantsReplaced | None:
        """Replace all of a principal's grants for one dimension with the given
        ``{value: can_write}`` set (the matrix's per-section save). ``None`` if the principal is
        unknown."""
        async with get_session_maker()() as s:
            # Lock the principal row for the transaction so two admins replacing the same section
            # serialize: the second waits for the first to commit, then runs its delete-then-insert
            # against the now-populated rows - a deterministic whole-section replace instead of both
            # scanning an empty section and colliding on the grant unique index (uncaught
            # IntegrityError). A no-op on SQLite (no row locks), where writes already serialize.
            if await s.get(Principal, principal_id, with_for_update=True) is None:
                return None
            replaced = await self._replace_grants(
                s, grant_model=Grant, fk_name="principal_id", owner_id=principal_id,
                dimension=dimension, values_write=values_write,
            )
            await s.commit()
            return replaced

    # --- teams --------------------------------------------------------------
    async def list_teams(self) -> list[Team]:
        async with get_session_maker()() as s:
            result = await s.execute(select(Team).order_by(Team.name))
            return list(result.scalars().all())

    async def count_teams(self, needle: str = "") -> int:
        """Count teams matching the (optional) name search - the ``total`` of the paged team matrix,
        so the panel renders page controls without loading every team."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = select(func.count()).select_from(Team)
            if cleaned:
                stmt = stmt.where(_team_name_match(cleaned))
            return int((await s.execute(stmt)).scalar_one())

    async def page_teams(self, *, needle: str, limit: int, offset: int) -> list[Team]:
        """One page of teams (name order), filtered by a case-insensitive name search. The admin
        matrix pages through these so a request never serializes every team's grants and membership;
        pair with ``count_teams`` for the total."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = select(Team)
            if cleaned:
                stmt = stmt.where(_team_name_match(cleaned))
            stmt = stmt.order_by(Team.name).limit(limit).offset(offset)
            return list((await s.execute(stmt)).scalars().all())

    async def get_team(self, team_id: int) -> Team | None:
        async with get_session_maker()() as s:
            return await s.get(Team, team_id)

    async def create_team(self, *, name: str) -> Team:
        """Create a team, rejecting a case-insensitive duplicate name atomically (the functional
        unique index on ``lower(name)`` is the backstop for the API's read-before-write check)."""
        canonical = name.strip()
        async with get_session_maker()() as s:
            team = Team(name=canonical)
            s.add(team)
            try:
                await s.commit()
            except IntegrityError as exc:
                await s.rollback()
                raise DuplicateTeamError(canonical) from exc
            await s.refresh(team)
            return team

    async def rename_team(self, team_id: int, name: str) -> Team | None:
        canonical = name.strip()
        async with get_session_maker()() as s:
            team = await s.get(Team, team_id)
            if team is None:
                return None
            team.name = canonical
            s.add(team)
            try:
                await s.commit()
            except IntegrityError as exc:
                # Use the pre-captured name: rollback expires `team`, so reading team.name here
                # would trigger implicit async I/O on an expired instance.
                await s.rollback()
                raise DuplicateTeamError(canonical) from exc
            await s.refresh(team)
            return team

    async def delete_team(self, team_id: int) -> bool:
        """Delete a team and its grants/memberships. The row lock serializes against membership and
        grant writers (which lock the team first), so none can insert a child mid-delete."""
        async with get_session_maker()() as s:
            team = await s.get(Team, team_id, with_for_update=True)
            if team is None:
                return False
            grants = (await s.execute(select(TeamGrant).where(TeamGrant.team_id == team_id))).scalars().all()
            members = (
                await s.execute(select(TeamMembership).where(TeamMembership.team_id == team_id))
            ).scalars().all()
            for row in (*grants, *members):
                await s.delete(row)
            await s.flush()  # emit child DELETEs before the team, or the FK rejects the delete
            await s.delete(team)
            await s.commit()
            return True

    # --- membership ---------------------------------------------------------
    async def list_team_members(self, team_id: int) -> list[Principal]:
        async with get_session_maker()() as s:
            result = await s.execute(
                select(Principal)
                .join(TeamMembership)
                .where(TeamMembership.team_id == team_id)
                .order_by(Principal.email)
            )
            return list(result.scalars().all())

    async def team_ids_for(self, principal_id: int) -> list[int]:
        async with get_session_maker()() as s:
            result = await s.execute(
                select(TeamMembership.team_id).where(TeamMembership.principal_id == principal_id)
            )
            return list(result.scalars().all())

    async def team_ids_by_principal(self) -> dict[int, list[int]]:
        """Every membership grouped by principal, in one query (bulk matrix read)."""
        async with get_session_maker()() as s:
            rows = (await s.execute(select(TeamMembership.principal_id, TeamMembership.team_id))).all()
        grouped: dict[int, list[int]] = {}
        for principal_id, team_id in rows:
            grouped.setdefault(principal_id, []).append(team_id)
        return grouped

    async def team_ids_by_principals(self, principal_ids: Sequence[int]) -> dict[int, list[int]]:
        """Memberships grouped by principal, constrained to the given ids (the current matrix page),
        so the admin matrix reads only the page's memberships instead of the tenant's."""
        if not principal_ids:
            return {}
        async with get_session_maker()() as s:
            rows = (
                await s.execute(
                    select(TeamMembership.principal_id, TeamMembership.team_id).where(
                        col(TeamMembership.principal_id).in_(principal_ids)
                    )
                )
            ).all()
        grouped: dict[int, list[int]] = {}
        for principal_id, team_id in rows:
            grouped.setdefault(principal_id, []).append(team_id)
        return grouped

    async def member_ids_by_team(self, team_ids: Sequence[int] | None = None) -> dict[int, list[int]]:
        """Membership grouped by team, in one query. Pass ``team_ids`` to bound the read to a page of
        teams so a request never serializes the whole tenant (an "Everyone" team's full membership);
        omit it for the bulk read."""
        if team_ids is not None and not team_ids:
            return {}
        async with get_session_maker()() as s:
            stmt = select(TeamMembership.team_id, TeamMembership.principal_id)
            if team_ids is not None:
                stmt = stmt.where(col(TeamMembership.team_id).in_(team_ids))
            rows = (await s.execute(stmt)).all()
        grouped: dict[int, list[int]] = {}
        for team_id, principal_id in rows:
            grouped.setdefault(team_id, []).append(principal_id)
        return grouped

    async def member_counts_by_team(self, team_ids: Sequence[int] | None = None) -> dict[int, int]:
        """Member count per team, in one grouped query. Pass ``team_ids`` to bound to a page of teams
        so the team list carries a count instead of every membership (an "Everyone" team's full set)."""
        if team_ids is not None and not team_ids:
            return {}
        async with get_session_maker()() as s:
            stmt = select(TeamMembership.team_id, func.count()).group_by(TeamMembership.team_id)
            if team_ids is not None:
                stmt = stmt.where(col(TeamMembership.team_id).in_(team_ids))
            rows = (await s.execute(stmt)).all()
        return {team_id: int(count) for team_id, count in rows}

    async def count_team_members(self, team_id: int, needle: str = "") -> int:
        """Count a team's members matching the (optional) email/name search - the ``total`` of the paged
        membership view, so the panel manages a large team without loading every member."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = (
                select(func.count())
                .select_from(TeamMembership)
                .join(Principal, col(Principal.id) == TeamMembership.principal_id)
                .where(TeamMembership.team_id == team_id)
            )
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            return int((await s.execute(stmt)).scalar_one())

    async def page_team_members(
        self, team_id: int, *, needle: str, limit: int, offset: int
    ) -> list[Principal]:
        """One page of a team's members (email order), filtered by the same email/name search as the
        directory, so membership never serializes the whole team in a single request."""
        cleaned = needle.strip().lower()
        async with get_session_maker()() as s:
            stmt = (
                select(Principal)
                .join(TeamMembership, col(Principal.id) == TeamMembership.principal_id)
                .where(TeamMembership.team_id == team_id)
            )
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            stmt = stmt.order_by(Principal.email).limit(limit).offset(offset)
            return list((await s.execute(stmt)).scalars().all())

    async def add_team_member(self, team_id: int, principal_id: int) -> MembersChanged | None:
        """Add one principal to a team (idempotent). Returns None if the team or principal is unknown,
        so a stale id is a 404 rather than a silent orphan. Incremental, so a large team is edited
        without resending its whole membership set."""
        async with get_session_maker()() as s:
            if await s.get(Team, team_id, with_for_update=True) is None:
                return None
            if await s.get(Principal, principal_id, with_for_update={"read": True}) is None:
                return None
            existing = (
                await s.execute(
                    select(TeamMembership).where(
                        TeamMembership.team_id == team_id,
                        TeamMembership.principal_id == principal_id,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                return MembersChanged()
            s.add(TeamMembership(team_id=team_id, principal_id=principal_id))
            await s.commit()
            return MembersChanged(added=(principal_id,))

    async def remove_team_member(self, team_id: int, principal_id: int) -> MembersChanged | None:
        """Remove one principal from a team (idempotent). Returns None only when the team is unknown."""
        async with get_session_maker()() as s:
            if await s.get(Team, team_id, with_for_update=True) is None:
                return None
            member = (
                await s.execute(
                    select(TeamMembership).where(
                        TeamMembership.team_id == team_id,
                        TeamMembership.principal_id == principal_id,
                    )
                )
            ).scalar_one_or_none()
            if member is None:
                return MembersChanged()
            await s.delete(member)
            await s.commit()
            return MembersChanged(removed=(principal_id,))

    async def replace_team_members(self, team_id: int, principal_ids: Iterable[int]) -> MembersChanged | None:
        """Replace a team's membership with the given principals. Unknown principal ids are
        dropped so a stale id can never wedge the save; returns None only when the team is unknown."""
        async with get_session_maker()() as s:
            # Lock the team row for the transaction so two admins replacing this team's membership
            # serialize into a deterministic whole-set replace, instead of both deriving from the old
            # set and interleaving deletes/inserts (a lost update or a unique-constraint collision).
            # A no-op on SQLite, where writes already serialize.
            if await s.get(Team, team_id, with_for_update=True) is None:
                return None
            members = (
                await s.execute(select(TeamMembership).where(TeamMembership.team_id == team_id))
            ).scalars().all()
            before = {member.principal_id for member in members}
            for member in members:
                await s.delete(member)
            await s.flush()
            wanted = list(dict.fromkeys(principal_ids))
            existing: set[int] = set()
            if wanted:
                live = select(Principal.id).where(col(Principal.id).in_(wanted)).with_for_update(read=True)
                existing = set((await s.execute(live)).scalars().all())
            for principal_id in existing:
                s.add(TeamMembership(team_id=team_id, principal_id=principal_id))
            await s.commit()
            return MembersChanged(added=tuple(sorted(existing - before)), removed=tuple(sorted(before - existing)))

    # --- team grants (the per-team read/write matrix) -----------------------
    async def list_team_grants(self, team_id: int) -> list[TeamGrant]:
        async with get_session_maker()() as s:
            result = await s.execute(select(TeamGrant).where(TeamGrant.team_id == team_id))
            return list(result.scalars().all())

    async def team_grants_by_team(
        self, team_ids: Sequence[int] | None = None
    ) -> dict[int, list[TeamGrant]]:
        """Team grants grouped by team, in one query. Pass ``team_ids`` to bound the read to a page of
        teams; omit it for the bulk read."""
        if team_ids is not None and not team_ids:
            return {}
        async with get_session_maker()() as s:
            stmt = select(TeamGrant)
            if team_ids is not None:
                stmt = stmt.where(col(TeamGrant.team_id).in_(team_ids))
            rows = (await s.execute(stmt)).scalars().all()
        grouped: dict[int, list[TeamGrant]] = {}
        for grant in rows:
            grouped.setdefault(grant.team_id, []).append(grant)
        return grouped

    async def replace_team_grants(
        self, team_id: int, dimension: str, values_write: Mapping[str, bool]
    ) -> GrantsReplaced | None:
        """Replace all of a team's grants for one dimension. Same delete-then-insert + normalize/
        dedupe protocol as the per-user ``replace_grants``, targeting a team. ``None`` if unknown."""
        async with get_session_maker()() as s:
            # Lock the team row for the transaction (see replace_grants): serializes concurrent
            # whole-section replaces for this team so they never both insert the same grant key.
            if await s.get(Team, team_id, with_for_update=True) is None:
                return None
            replaced = await self._replace_grants(
                s, grant_model=TeamGrant, fk_name="team_id", owner_id=team_id,
                dimension=dimension, values_write=values_write,
            )
            await s.commit()
            return replaced
