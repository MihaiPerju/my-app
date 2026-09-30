"""Rules and output shaping shared by the user and team halves of the admin matrix."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from db.models.custom_rbac import Grant, Team, TeamGrant
from fastapi import HTTPException

from ..domain import PAGE
from ..store import Normalizer, RbacStore
from .schemas import GrantEntry, GrantOut, TeamSummary
from .seams import CatalogProvider

#: Admin matrix page bounds (users and teams): the default page size and the hard cap a client may
#: request, so a single request can never be coerced into loading the whole tenant.
PAGE_DEFAULT = 50
PAGE_MAX = 200


def grantable(catalog: CatalogProvider) -> frozenset[str]:
    """The dimensions the matrix may grant: ``page`` plus the app's data dimensions."""
    return frozenset((PAGE, *catalog.dimensions()))


def check_dimension(catalog: CatalogProvider, dimension: str, entries: Sequence[GrantEntry]) -> None:
    """A dimension outside the catalog accepts only an empty set: the purge path for grants the
    catalog has since dropped, which would otherwise stay enforced with no way to clear them."""
    if dimension not in grantable(catalog) and entries:
        raise HTTPException(status_code=422, detail=f"Unknown dimension: {dimension}")


def values_write(entries: Iterable[GrantEntry]) -> dict[str, bool]:
    """Collapse the request to ``{value: can_write}``, write winning over a duplicate read entry."""
    collapsed: dict[str, bool] = {}
    for entry in entries:
        collapsed[entry.value] = collapsed.get(entry.value, False) or entry.write
    return collapsed


def reject_unknown_values(
    catalog: CatalogProvider, dimension: str, entries: Iterable[GrantEntry], normalize: Normalizer
) -> None:
    """Reject grant values absent from the dimension's catalog, so a direct API call cannot persist a
    value the matrix UI could never display or remove. Values are checked AFTER normalization - the
    same transform the store applies before writing - so a normalizer that rewrites a value cannot
    slip an un-cataloged code past this gate."""
    allowed = {entry.value for entry in catalog.catalog().get(dimension, ())}
    unknown = sorted({normalize(entry.value, dimension) for entry in entries} - allowed)
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Values not in the {dimension!r} catalog: {', '.join(unknown)}",
        )


def grants_out(grants: Iterable[Grant | TeamGrant]) -> list[GrantOut]:
    return sorted(
        (GrantOut(dimension=g.dimension, value=g.value, write=g.write) for g in grants),
        key=lambda g: (g.dimension, g.value),
    )


def team_summary(team: Team, grants: Iterable[TeamGrant], member_count: int) -> TeamSummary:
    assert team.id is not None
    return TeamSummary(
        id=team.id,
        name=team.name,
        member_count=member_count,
        grants=grants_out(grants),
    )


async def one_team(store: RbacStore, team: Team) -> TeamSummary:
    assert team.id is not None
    return team_summary(team, await store.list_team_grants(team.id), await store.count_team_members(team.id))
