"""Read-side access resolution: a caller's raw grants, unioned across their teams and any legacy
per-user grants.

This is what the ``AccessPolicy`` calls on every request; the write side (the admin matrix) is
``RbacStore`` in ``store``. Email resolution is case-insensitive (a caller's SSO email casing must
not change what they can see); every filter is a bound parameter. The whole resolution is a fixed
two round trips - the principal lookup, then one ``UNION ALL`` that gathers the direct grants and
the team grants (via a membership join) together - so an authorized request does not scale its
query count with the caller's team count.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from db.models.custom_rbac import Grant, Principal, TeamGrant, TeamMembership
from sqlalchemy import func, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select


@dataclass(frozen=True, slots=True)
class ResolvedAccess:
    """A caller's raw authorization: admin flag + readable/writable values per dimension
    (before the policy layers on the app's dimension config)."""

    is_admin: bool
    read: Mapping[str, frozenset[str]]
    write: Mapping[str, frozenset[str]]


async def resolve_access(session: AsyncSession, email: str) -> ResolvedAccess | None:
    """The caller's admin flag + grants grouped by dimension, unioned across their teams and
    any legacy per-user grants. ``None`` when no principal matches the email (an unknown
    caller), which the policy treats as deny. The email match is case-insensitive; every
    filter is a bound parameter."""
    lookup = email.strip().lower()
    principal = (
        await session.execute(select(Principal).where(func.lower(Principal.email) == lookup))
    ).scalars().first()
    if principal is None:
        return None

    # One query for every effective grant: the principal's own grants plus the grants of every
    # team they belong to (joined through membership), so team count adds rows, not round trips.
    direct = select(Grant.dimension, Grant.value, Grant.write).where(Grant.principal_id == principal.id)
    via_team = (
        select(TeamGrant.dimension, TeamGrant.value, TeamGrant.write)
        .join(TeamMembership, TeamGrant.team_id == TeamMembership.team_id)
        .where(TeamMembership.principal_id == principal.id)
    )
    rows = (await session.execute(union_all(direct, via_team))).all()

    read: dict[str, set[str]] = {}
    write: dict[str, set[str]] = {}
    for dimension, value, can_write in rows:
        read.setdefault(dimension, set()).add(value)
        if can_write:
            write.setdefault(dimension, set()).add(value)

    return ResolvedAccess(
        is_admin=principal.is_admin,
        read={dim: frozenset(values) for dim, values in read.items()},
        write={dim: frozenset(values) for dim, values in write.items()},
    )
