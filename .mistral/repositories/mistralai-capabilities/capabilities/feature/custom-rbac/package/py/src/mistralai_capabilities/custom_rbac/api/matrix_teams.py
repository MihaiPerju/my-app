"""Admin API, team half: teams, their memberships, and their per-dimension grants.

Permissions attach to teams; users join teams and inherit the union of their teams' grants (plus
any legacy per-user grants). The per-dimension grant matrix is the same shape as the per-user one,
so the frontend reuses it. Included by ``matrix``, so it shares the ``/admin`` prefix and the
``require_admin`` gate (declared here too, so the router is safe to mount on its own). Every
mutation is audited under the real caller.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from db.models.custom_rbac import Principal, Team, TeamGrant
from fastapi import APIRouter, Depends, HTTPException, Query

from ..store import DuplicateTeamError
from .audit import audit
from .matrix_shared import (
    PAGE_DEFAULT,
    PAGE_MAX,
    check_dimension,
    one_team,
    reject_unknown_values,
    team_summary,
    values_write,
)
from .schemas import GrantsReplace, MemberOut, MembersReplace, TeamMembersPage, TeamName, TeamsPage, TeamSummary
from .seams import CatalogDep, StoreDep
from .security import Actor, require_admin

router = APIRouter(dependencies=[Depends(require_admin)])


def _member_out(principal: Principal) -> MemberOut:
    assert principal.id is not None
    return MemberOut(id=principal.id, email=principal.email, name=principal.name)


def _teams_page(
    teams: Sequence[Team],
    grants_by_team: Mapping[int, Sequence[TeamGrant]],
    counts_by_team: Mapping[int, int],
    *,
    total: int,
    limit: int,
    offset: int,
) -> TeamsPage:
    """Assemble one team-matrix page from a page of teams and the grants + member counts fetched for
    exactly those teams. Pure (no IO), so the pagination shape is unit-tested without a DB."""
    items = [team_summary(t, grants_by_team.get(t.id or -1, ()), counts_by_team.get(t.id or -1, 0)) for t in teams]
    return TeamsPage(items=items, total=total, limit=limit, offset=offset)


def _members_page(members: Sequence[Principal], *, total: int, limit: int, offset: int) -> TeamMembersPage:
    """Assemble one membership page. Pure (no IO), so the shape is unit-tested without a DB."""
    return TeamMembersPage(items=[_member_out(p) for p in members], total=total, limit=limit, offset=offset)


@router.get("/teams", response_model=TeamsPage)
async def list_teams(
    store: StoreDep,
    limit: int = Query(PAGE_DEFAULT, ge=1, le=PAGE_MAX),
    offset: int = Query(0, ge=0),
    q: str = "",
) -> TeamsPage:
    # Four queries, every one bounded by the page: the total for the query, the page of teams, and the
    # grants + member COUNTS for exactly those teams - so an "Everyone" team never serializes one id per
    # tenant user (membership is read through /teams/{id}/members). ``q`` filters by team name.
    total = await store.count_teams(q)
    teams = await store.page_teams(needle=q, limit=limit, offset=offset)
    ids = [t.id for t in teams if t.id is not None]
    grants_by_team = await store.team_grants_by_team(ids)
    counts_by_team = await store.member_counts_by_team(ids)
    return _teams_page(teams, grants_by_team, counts_by_team, total=total, limit=limit, offset=offset)


async def _existing_team(store: StoreDep, team_id: int) -> TeamSummary:
    """The team's summary after a write, or 404 if a concurrent delete removed it meanwhile."""
    team = await store.get_team(team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Unknown team.")
    return await one_team(store, team)


@router.post("/teams", response_model=TeamSummary)
async def create_team(body: TeamName, store: StoreDep, actor: Actor) -> TeamSummary:
    # Uniqueness is enforced atomically by the DB (functional unique index on lower(name)) and
    # surfaced as DuplicateTeamError -> 422; no read-before-write scan needed.
    try:
        team = await store.create_team(name=body.name)
    except DuplicateTeamError:
        raise HTTPException(status_code=422, detail=f"A team named {body.name!r} already exists.") from None
    audit(actor, "team_created", team_id=team.id, name=team.name)
    return await one_team(store, team)


@router.patch("/teams/{team_id}", response_model=TeamSummary)
async def rename_team(team_id: int, body: TeamName, store: StoreDep, actor: Actor) -> TeamSummary:
    before = await store.get_team(team_id)
    try:
        team = await store.rename_team(team_id, body.name)
    except DuplicateTeamError:
        raise HTTPException(status_code=422, detail=f"A team named {body.name!r} already exists.") from None
    if team is None:
        raise HTTPException(status_code=404, detail="Unknown team.")
    audit(actor, "team_renamed", team_id=team_id, before=before.name if before else None, after=team.name)
    return await one_team(store, team)


@router.delete("/teams/{team_id}", status_code=204)
async def delete_team(team_id: int, store: StoreDep, actor: Actor) -> None:
    team = await store.get_team(team_id)
    if team is None or not await store.delete_team(team_id):
        raise HTTPException(status_code=404, detail="Unknown team.")
    audit(actor, "team_deleted", team_id=team_id, name=team.name)


@router.put("/teams/{team_id}/members", response_model=TeamSummary)
async def replace_members(team_id: int, body: MembersReplace, store: StoreDep, actor: Actor) -> TeamSummary:
    """Replace a team's whole membership set (kept for bulk edits). Prefer the incremental
    ``PUT``/``DELETE .../members/{principal_id}`` for large teams, which never resend the full set."""
    changed = await store.replace_team_members(team_id, body.principal_ids)
    if changed is None:
        raise HTTPException(status_code=404, detail="Unknown team.")
    if changed.added or changed.removed:
        audit(
            actor,
            "team_members_replaced",
            team_id=team_id,
            added=list(changed.added),
            removed=list(changed.removed),
        )
    return await _existing_team(store, team_id)


@router.get("/teams/{team_id}/members", response_model=TeamMembersPage)
async def list_team_members(
    team_id: int,
    store: StoreDep,
    limit: int = Query(PAGE_DEFAULT, ge=1, le=PAGE_MAX),
    offset: int = Query(0, ge=0),
    q: str = "",
) -> TeamMembersPage:
    """One page of a team's members (email order), searchable by ``q`` - so an admin manages a large
    team without the endpoint ever loading its whole membership at once."""
    if await store.get_team(team_id) is None:
        raise HTTPException(status_code=404, detail="Unknown team.")
    total = await store.count_team_members(team_id, q)
    members = await store.page_team_members(team_id, needle=q, limit=limit, offset=offset)
    return _members_page(members, total=total, limit=limit, offset=offset)


@router.put("/teams/{team_id}/members/{principal_id}", response_model=TeamSummary)
async def add_member(team_id: int, principal_id: int, store: StoreDep, actor: Actor) -> TeamSummary:
    """Add one principal to a team (idempotent) - the incremental edit, so a large team is changed
    without resending its whole membership set. 404 if the team or user is unknown."""
    changed = await store.add_team_member(team_id, principal_id)
    if changed is None:
        raise HTTPException(status_code=404, detail="Unknown team or user.")
    if changed.added:
        audit(actor, "team_member_added", team_id=team_id, principal_id=principal_id)
    return await _existing_team(store, team_id)


@router.delete("/teams/{team_id}/members/{principal_id}", response_model=TeamSummary)
async def remove_member(team_id: int, principal_id: int, store: StoreDep, actor: Actor) -> TeamSummary:
    """Remove one principal from a team (idempotent). 404 only if the team is unknown."""
    changed = await store.remove_team_member(team_id, principal_id)
    if changed is None:
        raise HTTPException(status_code=404, detail="Unknown team.")
    if changed.removed:
        audit(actor, "team_member_removed", team_id=team_id, principal_id=principal_id)
    return await _existing_team(store, team_id)


@router.put("/teams/{team_id}/grants/{dimension}", response_model=TeamSummary)
async def replace_team_grants(
    team_id: int, dimension: str, body: GrantsReplace, store: StoreDep, catalog: CatalogDep, actor: Actor
) -> TeamSummary:
    """Replace a team's grants for one dimension. Same per-section save as the per-user matrix,
    targeting a team."""
    check_dimension(catalog, dimension, body.entries)
    reject_unknown_values(catalog, dimension, body.entries, store.normalize)
    replaced = await store.replace_team_grants(team_id, dimension, values_write(body.entries))
    if replaced is None:
        raise HTTPException(status_code=404, detail="Unknown team.")
    audit(
        actor,
        "team_grants_replaced",
        team_id=team_id,
        dimension=dimension,
        before=list(replaced.before),
        after=list(replaced.after),
    )
    out = await _existing_team(store, team_id)
    return out
