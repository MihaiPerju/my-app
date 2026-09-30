"""Write access to the RBAC store (sync): the admin matrix the panel drives.

Sync SQLModel/SQLAlchemy over an injected ``Engine`` (the app shares the one its pg access policy
reads). The read side (``resolve_access``), which the ``AccessPolicy`` calls on every request, lives
in ``resolve``. Sessions use ``expire_on_commit=False`` so returned rows stay readable after the
session closes - the app's routers map them to API models outside the ``with`` block.

Nothing here is domain-specific: the dimension vocabulary is the caller's, and value canonicalization
is an injected ``normalize`` hook (default: strip), so an app that needs e.g. upper-cased codes on one
dimension supplies one without this module knowing its dimensions.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import ColumnElement, Engine, func, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from .models import Grant, Principal, Team, TeamGrant, TeamMembership

#: Canonicalize a grant value for a dimension. Default: trim. An app injects its own (e.g. upper-case
#: a code dimension) so the stored value matches what enforcement compares against.
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
    """A team with the same name already exists."""


class LastAdminError(ValueError):
    """The change would leave no administrator, locking everyone out of the admin API."""


def _lock_admin_ids(s: Session) -> set[int]:
    """Lock every admin row (in id order, so concurrent callers never deadlock) and return their ids,
    so a demotion or deletion checks and applies the "at least one admin" invariant atomically."""
    stmt = select(Principal.id).where(col(Principal.is_admin)).order_by(col(Principal.id)).with_for_update()
    return {pid for pid in s.exec(stmt).all() if pid is not None}


@dataclass(frozen=True, slots=True)
class RbacStore:
    """The admin matrix: principals, teams, and their read/write grants. Sync SQLModel on an injected
    engine. ``normalize`` canonicalizes grant values per dimension (default: strip)."""

    engine: Engine
    normalize: Normalizer = _strip

    def _session(self) -> Session:
        return Session(self.engine, expire_on_commit=False)

    # --- principals ---------------------------------------------------------
    def list_principals(self) -> list[Principal]:
        with self._session() as s:
            return list(s.exec(select(Principal).order_by(Principal.email)).all())

    def get_principal(self, principal_id: int) -> Principal | None:
        with self._session() as s:
            return s.get(Principal, principal_id)

    def principals_by_emails(self, emails: Iterable[str]) -> list[Principal]:
        """The principals whose email case-insensitively matches one of ``emails``, resolved in SQL
        so a lookup of a few addresses never loads the whole tenant."""
        folded = {e.strip().lower() for e in emails if e.strip()}
        if not folded:
            return []
        with self._session() as s:
            return list(s.exec(select(Principal).where(func.lower(Principal.email).in_(folded))).all())

    def admin_emails(self) -> frozenset[str]:
        """The emails of admin principals. Useful to exclude operator/test activity from usage
        analytics: admins bypass access, so their activity is noise."""
        with self._session() as s:
            return frozenset(
                s.exec(select(Principal.email).where(col(Principal.is_admin))).all()
            )

    def case_duplicate_emails(self) -> list[str]:
        """Folded emails held by more than one principal: legacy rows the adopted schema's
        case-sensitive ``unique(email)`` admitted, which authorization cannot tell apart."""
        folded = func.lower(Principal.email)
        with self._session() as s:
            return list(s.exec(select(folded).group_by(folded).having(func.count() > 1)).all())

    def search_principals(self, needle: str, limit: int) -> list[Principal]:
        """Case-insensitive email/name search, ordered and capped in SQL so a large workspace never
        loads every principal to filter in Python (the directory picker's query)."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = select(Principal)
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            stmt = stmt.order_by(Principal.email).limit(limit)
            return list(s.exec(stmt).all())

    def count_principals(self, needle: str = "") -> int:
        """Count principals matching the (optional) email/name search - the ``total`` of the paged
        admin matrix, so the panel can render page controls without loading the whole tenant."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = select(func.count()).select_from(Principal)
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            return int(s.exec(stmt).one())

    def page_principals(self, *, needle: str, limit: int, offset: int) -> list[Principal]:
        """One page of principals (email order), filtered by the same case-insensitive email/name
        search as the directory. The admin matrix pages through these so a request never scales with
        the whole tenant; pair with ``count_principals`` for the total."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = select(Principal)
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            stmt = stmt.order_by(Principal.email).limit(limit).offset(offset)
            return list(s.exec(stmt).all())

    def create_principal(
        self,
        *,
        email: str,
        name: str,
        is_admin: bool = False,
    ) -> Principal:
        """Create a principal, rejecting a case-insensitive duplicate email. The stored email is
        case-folded so the table's plain ``unique(email)`` index enforces case-insensitive uniqueness
        atomically even under concurrent inserts (this adoption variant keeps the deployed schema, so
        it cannot rely on a ``lower(email)`` functional index); the folded pre-check still catches a
        clash against a legacy mixed-case row. A new principal joins no team: team membership is
        always explicit."""
        canonical = email.strip().lower()
        with self._session() as s:
            clash = s.exec(
                select(Principal).where(func.lower(Principal.email) == canonical)
            ).first()
            if clash is not None:
                raise DuplicatePrincipalError(canonical)
            principal = Principal(email=canonical, name=name, is_admin=is_admin)
            s.add(principal)
            try:
                s.commit()
            except IntegrityError as exc:
                s.rollback()
                raise DuplicatePrincipalError(canonical) from exc
            s.refresh(principal)
            return principal

    def set_admin(self, principal_id: int, is_admin: bool) -> Principal | None:
        """Set the admin flag. Raises ``LastAdminError`` rather than demote the only admin."""
        with self._session() as s:
            if not is_admin and _lock_admin_ids(s) == {principal_id}:
                raise LastAdminError(principal_id)
            principal = s.get(Principal, principal_id, with_for_update=True)
            if principal is None:
                return None
            principal.is_admin = is_admin
            s.add(principal)
            s.commit()
            s.refresh(principal)
            return principal

    def delete_principal(self, principal_id: int) -> bool:
        """Delete a principal with its grants and memberships. Raises ``LastAdminError`` rather than
        delete the only admin. The row lock serializes against concurrent grant/membership writes
        (which lock or share-lock the principal), so none can insert a row pointing at it mid-delete."""
        with self._session() as s:
            if _lock_admin_ids(s) == {principal_id}:
                raise LastAdminError(principal_id)
            principal = s.get(Principal, principal_id, with_for_update=True)
            if principal is None:
                return False
            for grant in s.exec(
                select(Grant).where(Grant.principal_id == principal_id)
            ).all():
                s.delete(grant)
            for member in s.exec(
                select(TeamMembership).where(
                    TeamMembership.principal_id == principal_id
                )
            ).all():
                s.delete(member)
            s.flush()  # emit child DELETEs before the principal, or the FK rejects the delete
            s.delete(principal)
            s.commit()
            return True

    # --- grants (the read/write matrix) -------------------------------------
    def list_grants(self, principal_id: int) -> list[Grant]:
        with self._session() as s:
            return list(
                s.exec(select(Grant).where(Grant.principal_id == principal_id)).all()
            )

    def grants_by_principal(self) -> dict[int, list[Grant]]:
        """Every grant grouped by principal, in one query - so listing the matrix costs a fixed number
        of round trips instead of one per principal."""
        with self._session() as s:
            rows = s.exec(select(Grant)).all()
        grouped: dict[int, list[Grant]] = {}
        for grant in rows:
            grouped.setdefault(grant.principal_id, []).append(grant)
        return grouped

    def grants_by_principals(self, principal_ids: Sequence[int]) -> dict[int, list[Grant]]:
        """Grants grouped by principal, constrained to the given ids (the current matrix page), so the
        admin matrix reads only the page's grants instead of every grant in the tenant."""
        if not principal_ids:
            return {}
        with self._session() as s:
            rows = s.exec(
                select(Grant).where(col(Grant.principal_id).in_(principal_ids))
            ).all()
        grouped: dict[int, list[Grant]] = {}
        for grant in rows:
            grouped.setdefault(grant.principal_id, []).append(grant)
        return grouped

    def _replace_grants(
        self,
        s: Session,
        *,
        grant_model: type[Grant | TeamGrant],
        fk_name: str,
        owner_id: int,
        dimension: str,
        values_write: Mapping[str, bool],
    ) -> None:
        """Delete-then-insert one dimension's grants for an owner within an open session - the shared
        primitive behind the per-user and per-team matrix saves. The DELETEs flush before the INSERTs
        (SQLAlchemy emits inserts first in one flush, which would collide with a not-yet-deleted row on
        the unique constraint); values are normalized then deduped (write wins) so two entries that
        canonicalize to the same value collapse to one row."""
        owner_col = getattr(grant_model, fk_name)
        for grant in s.exec(
            select(grant_model).where(
                owner_col == owner_id, grant_model.dimension == dimension
            )
        ).all():
            s.delete(grant)
        s.flush()
        collapsed: dict[str, bool] = {}
        for raw_value, can_write in values_write.items():
            value = self.normalize(raw_value, dimension)
            if value:
                collapsed[value] = collapsed.get(value, False) or can_write
        for value, can_write in collapsed.items():
            s.add(
                grant_model(
                    **{
                        fk_name: owner_id,
                        "dimension": dimension,
                        "value": value,
                        "write": can_write,
                    }
                )
            )

    def replace_grants(
        self, principal_id: int, dimension: str, values_write: Mapping[str, bool]
    ) -> bool:
        """Replace all of a principal's grants for one dimension with the given ``{value: can_write}``
        set (the matrix's per-section save)."""
        with self._session() as s:
            # Lock the principal row for the transaction so two admins replacing the same section
            # serialize: the second waits for the first to commit, then runs its delete-then-insert
            # against the now-populated rows - a deterministic whole-section replace instead of both
            # scanning an empty section and colliding on the grant unique index. A no-op on SQLite
            # (no row locks), where writes already serialize.
            if s.get(Principal, principal_id, with_for_update=True) is None:
                return False
            self._replace_grants(
                s,
                grant_model=Grant,
                fk_name="principal_id",
                owner_id=principal_id,
                dimension=dimension,
                values_write=values_write,
            )
            s.commit()
            return True

    # --- teams --------------------------------------------------------------
    def list_teams(self) -> list[Team]:
        with self._session() as s:
            return list(s.exec(select(Team).order_by(Team.name)).all())

    def count_teams(self, needle: str = "") -> int:
        """Count teams matching the (optional) name search - the ``total`` of the paged team matrix."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = select(func.count()).select_from(Team)
            if cleaned:
                stmt = stmt.where(_team_name_match(cleaned))
            return int(s.exec(stmt).one())

    def page_teams(self, *, needle: str, limit: int, offset: int) -> list[Team]:
        """One page of teams (name order), filtered by a case-insensitive name search, so a request
        never serializes every team's grants and membership; pair with ``count_teams`` for the total."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = select(Team)
            if cleaned:
                stmt = stmt.where(_team_name_match(cleaned))
            stmt = stmt.order_by(Team.name).limit(limit).offset(offset)
            return list(s.exec(stmt).all())

    def get_team(self, team_id: int) -> Team | None:
        with self._session() as s:
            return s.get(Team, team_id)

    def create_team(self, *, name: str) -> Team:
        """Create a team. ``name`` is a free-text display label: its casing and spaces are preserved
        (``FP&A`` stays ``FP&A``). Uniqueness is case-insensitive via a folded pre-check
        (``lower(name)``), so ``Finance`` and ``finance`` cannot coexist. The plain ``unique(name)``
        index is the atomic backstop for an exact-case duplicate; a concurrent case-variant insert is
        caught by the pre-check (this adoption variant keeps the deployed schema, so it has no
        ``lower(name)`` functional index for atomic case-insensitive uniqueness)."""
        display = name.strip()
        folded = display.lower()
        with self._session() as s:
            clash = s.exec(select(Team).where(func.lower(Team.name) == folded)).first()
            if clash is not None:
                raise DuplicateTeamError(display)
            team = Team(name=display)
            s.add(team)
            try:
                s.commit()
            except IntegrityError as exc:
                s.rollback()
                raise DuplicateTeamError(display) from exc
            s.refresh(team)
            return team

    def rename_team(self, team_id: int, name: str) -> Team | None:
        display = name.strip()
        folded = display.lower()
        with self._session() as s:
            team = s.get(Team, team_id)
            if team is None:
                return None
            clash = s.exec(
                select(Team).where(func.lower(Team.name) == folded, col(Team.id) != team_id)
            ).first()
            if clash is not None:
                raise DuplicateTeamError(display)
            team.name = display
            s.add(team)
            try:
                s.commit()
            except IntegrityError as exc:
                s.rollback()
                raise DuplicateTeamError(display) from exc
            s.refresh(team)
            return team

    def delete_team(self, team_id: int) -> bool:
        """Delete a team and its grants/memberships. The row lock serializes against membership and
        grant writers (which lock the team first), so none can insert a child mid-delete."""
        with self._session() as s:
            team = s.get(Team, team_id, with_for_update=True)
            if team is None:
                return False
            for grant in s.exec(
                select(TeamGrant).where(TeamGrant.team_id == team_id)
            ).all():
                s.delete(grant)
            for member in s.exec(
                select(TeamMembership).where(TeamMembership.team_id == team_id)
            ).all():
                s.delete(member)
            s.flush()  # emit child DELETEs before the team, or the FK rejects the delete
            s.delete(team)
            s.commit()
            return True

    # --- membership ---------------------------------------------------------
    def list_team_members(self, team_id: int) -> list[Principal]:
        with self._session() as s:
            return list(
                s.exec(
                    select(Principal)
                    .join(TeamMembership)
                    .where(TeamMembership.team_id == team_id)
                    .order_by(Principal.email)
                ).all()
            )

    def team_ids_for(self, principal_id: int) -> list[int]:
        with self._session() as s:
            return list(
                s.exec(
                    select(TeamMembership.team_id).where(
                        TeamMembership.principal_id == principal_id
                    )
                ).all()
            )

    def team_ids_by_principal(self) -> dict[int, list[int]]:
        """Every membership grouped by principal, in one query (bulk matrix read)."""
        with self._session() as s:
            rows = s.exec(
                select(TeamMembership.principal_id, TeamMembership.team_id)
            ).all()
        grouped: dict[int, list[int]] = {}
        for principal_id, team_id in rows:
            grouped.setdefault(principal_id, []).append(team_id)
        return grouped

    def team_ids_by_principals(self, principal_ids: Sequence[int]) -> dict[int, list[int]]:
        """Memberships grouped by principal, constrained to the given ids (the current matrix page),
        so the admin matrix reads only the page's memberships instead of the tenant's."""
        if not principal_ids:
            return {}
        with self._session() as s:
            rows = s.exec(
                select(TeamMembership.principal_id, TeamMembership.team_id).where(
                    col(TeamMembership.principal_id).in_(principal_ids)
                )
            ).all()
        grouped: dict[int, list[int]] = {}
        for principal_id, team_id in rows:
            grouped.setdefault(principal_id, []).append(team_id)
        return grouped

    def member_ids_by_team(self, team_ids: Sequence[int] | None = None) -> dict[int, list[int]]:
        """Membership grouped by team, in one query. Pass ``team_ids`` to bound the read to a page of
        teams so a request never serializes the whole tenant (an "Everyone" team's full membership);
        omit it for the bulk read."""
        if team_ids is not None and not team_ids:
            return {}
        with self._session() as s:
            stmt = select(TeamMembership.team_id, TeamMembership.principal_id)
            if team_ids is not None:
                stmt = stmt.where(col(TeamMembership.team_id).in_(team_ids))
            rows = s.exec(stmt).all()
        grouped: dict[int, list[int]] = {}
        for team_id, principal_id in rows:
            grouped.setdefault(team_id, []).append(principal_id)
        return grouped

    def member_counts_by_team(self, team_ids: Sequence[int] | None = None) -> dict[int, int]:
        """Member count per team, in one grouped query. Pass ``team_ids`` to bound to a page of teams
        so the team list carries a count instead of every membership (an "Everyone" team's full set)."""
        if team_ids is not None and not team_ids:
            return {}
        with self._session() as s:
            stmt = select(TeamMembership.team_id, func.count()).group_by(TeamMembership.team_id)
            if team_ids is not None:
                stmt = stmt.where(col(TeamMembership.team_id).in_(team_ids))
            rows = s.exec(stmt).all()
        return {team_id: int(count) for team_id, count in rows}

    def count_team_members(self, team_id: int, needle: str = "") -> int:
        """Count a team's members matching the (optional) email/name search - the ``total`` of the paged
        membership view, so the panel manages a large team without loading every member."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = (
                select(func.count())
                .select_from(TeamMembership)
                .join(Principal, col(Principal.id) == TeamMembership.principal_id)
                .where(TeamMembership.team_id == team_id)
            )
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            return int(s.exec(stmt).one())

    def page_team_members(
        self, team_id: int, *, needle: str, limit: int, offset: int
    ) -> list[Principal]:
        """One page of a team's members (email order), filtered by the same email/name search as the
        directory, so membership never serializes the whole team in a single request."""
        cleaned = needle.strip().lower()
        with self._session() as s:
            stmt = (
                select(Principal)
                .join(TeamMembership, col(Principal.id) == TeamMembership.principal_id)
                .where(TeamMembership.team_id == team_id)
            )
            if cleaned:
                stmt = stmt.where(_email_name_match(cleaned))
            stmt = stmt.order_by(Principal.email).limit(limit).offset(offset)
            return list(s.exec(stmt).all())

    def add_team_member(self, team_id: int, principal_id: int) -> bool:
        """Add one principal to a team (idempotent). Returns False if the team or principal is unknown,
        so a stale id is a 404 rather than a silent orphan. Incremental, so a large team is edited
        without resending its whole membership set."""
        with self._session() as s:
            if s.get(Team, team_id, with_for_update=True) is None:
                return False
            if s.get(Principal, principal_id, with_for_update={"read": True}) is None:
                return False
            existing = s.exec(
                select(TeamMembership).where(
                    TeamMembership.team_id == team_id,
                    TeamMembership.principal_id == principal_id,
                )
            ).one_or_none()
            if existing is None:
                s.add(TeamMembership(team_id=team_id, principal_id=principal_id))
            s.commit()
            return True

    def remove_team_member(self, team_id: int, principal_id: int) -> bool:
        """Remove one principal from a team (idempotent). Returns False only when the team is unknown."""
        with self._session() as s:
            if s.get(Team, team_id, with_for_update=True) is None:
                return False
            member = s.exec(
                select(TeamMembership).where(
                    TeamMembership.team_id == team_id,
                    TeamMembership.principal_id == principal_id,
                )
            ).one_or_none()
            if member is not None:
                s.delete(member)
            s.commit()
            return True

    def replace_team_members(self, team_id: int, principal_ids: Iterable[int]) -> bool:
        """Replace a team's membership with the given principals. Unknown principal ids are dropped so
        a stale id can never wedge the save; returns False only when the team is unknown."""
        with self._session() as s:
            # Lock the team row for the transaction (see replace_grants): serializes concurrent
            # whole-set membership replaces into a deterministic result instead of interleaving
            # deletes/inserts derived from a stale set.
            if s.get(Team, team_id, with_for_update=True) is None:
                return False
            for member in s.exec(
                select(TeamMembership).where(TeamMembership.team_id == team_id)
            ).all():
                s.delete(member)
            s.flush()
            wanted = list(dict.fromkeys(principal_ids))
            existing: set[int] = set()
            if wanted:
                existing = set(
                    s.exec(
                        select(Principal.id)
                        .where(col(Principal.id).in_(wanted))
                        .with_for_update(read=True)
                    ).all()
                )
            for principal_id in existing:
                s.add(TeamMembership(team_id=team_id, principal_id=principal_id))
            s.commit()
            return True

    # --- team grants (the per-team read/write matrix) -----------------------
    def list_team_grants(self, team_id: int) -> list[TeamGrant]:
        with self._session() as s:
            return list(
                s.exec(select(TeamGrant).where(TeamGrant.team_id == team_id)).all()
            )

    def team_grants_by_team(
        self, team_ids: Sequence[int] | None = None
    ) -> dict[int, list[TeamGrant]]:
        """Team grants grouped by team, in one query. Pass ``team_ids`` to bound the read to a page of
        teams; omit it for the bulk read."""
        if team_ids is not None and not team_ids:
            return {}
        with self._session() as s:
            stmt = select(TeamGrant)
            if team_ids is not None:
                stmt = stmt.where(col(TeamGrant.team_id).in_(team_ids))
            rows = s.exec(stmt).all()
        grouped: dict[int, list[TeamGrant]] = {}
        for grant in rows:
            grouped.setdefault(grant.team_id, []).append(grant)
        return grouped

    def replace_team_grants(
        self, team_id: int, dimension: str, values_write: Mapping[str, bool]
    ) -> bool:
        """Replace all of a team's grants for one dimension. Same delete-then-insert + normalize/dedupe
        protocol as the per-user ``replace_grants``, targeting a team. Returns False if unknown."""
        with self._session() as s:
            # Lock the team row for the transaction (see replace_grants): serializes concurrent
            # whole-section replaces for this team so they never both insert the same grant key.
            if s.get(Team, team_id, with_for_update=True) is None:
                return False
            self._replace_grants(
                s,
                grant_model=TeamGrant,
                fk_name="team_id",
                owner_id=team_id,
                dimension=dimension,
                values_write=values_write,
            )
            s.commit()
            return True
