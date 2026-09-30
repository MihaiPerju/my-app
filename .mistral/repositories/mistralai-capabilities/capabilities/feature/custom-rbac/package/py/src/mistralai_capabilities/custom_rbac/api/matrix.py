"""Admin API: manage the RBAC read/write matrix (principals + teams + their grants).

Every route is gated by ``require_admin``. A user is an admin (full bypass) or a set of grants;
each grant is read access to a value of a dimension (``page`` plus the app's data dimensions),
with ``write`` adding write. The ``PUT .../grants/{dimension}`` routes replace a whole section of
the matrix at once (the panel's per-section save). The pages, the data dimensions and the
grantable values all come from the host's ``CatalogProvider``, so this router carries no domain
vocabulary; a value not in that catalog is rejected rather than persisted where the UI could never
show or remove it. Bootstrap admins are protected: they cannot be demoted or deleted here (the app
also re-promotes them on boot), and are flagged so the UI locks their controls. No admin can demote
or delete themselves, and the last admin can never be removed. Every mutation is audited
(``audit``) under the real caller, never an act-as target. The team routes live in ``matrix_teams``
and are included here, so they share the prefix and the admin gate.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from db.models.custom_rbac import Grant, Principal
from fastapi import APIRouter, Depends, HTTPException, Query

from ..store import DuplicatePrincipalError, LastAdminError, RbacStore
from .audit import audit
from .matrix_shared import (
    PAGE_DEFAULT,
    PAGE_MAX,
    check_dimension,
    grants_out,
    reject_unknown_values,
    values_write,
)
from .matrix_teams import router as teams_router
from .schemas import AdminFlag, CatalogItemOut, CatalogOut, GrantsReplace, SchemaOut, UserCreate, UserOut, UsersPage
from .seams import CatalogDep, ProtectedDep, StoreDep
from .security import Actor, require_admin

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])
router.include_router(teams_router)


def _user_out(
    principal: Principal, protected: frozenset[str], grants: Iterable[Grant], team_ids: Sequence[int]
) -> UserOut:
    assert principal.id is not None
    return UserOut(
        id=principal.id,
        email=principal.email,
        name=principal.name,
        is_admin=principal.is_admin,
        grants=grants_out(grants),
        team_ids=sorted(team_ids),
        protected=principal.email.lower() in protected,
    )


async def _one_user(store: RbacStore, principal: Principal, protected: frozenset[str]) -> UserOut:
    assert principal.id is not None
    return _user_out(
        principal, protected, await store.list_grants(principal.id), await store.team_ids_for(principal.id)
    )


@router.get("/schema", response_model=SchemaOut)
async def get_schema(catalog: CatalogDep) -> SchemaOut:
    tabs = getattr(catalog, "tabs", dict)()
    return SchemaOut(
        pages=list(catalog.pages()),
        dimensions=list(catalog.dimensions()),
        tabs={page: list(values) for page, values in tabs.items()},
    )


@router.get("/catalog", response_model=CatalogOut)
async def get_catalog(catalog: CatalogDep) -> CatalogOut:
    return CatalogOut(
        catalog={
            dimension: [CatalogItemOut(value=e.value, label=e.label) for e in entries]
            for dimension, entries in catalog.catalog().items()
        }
    )


def _users_page(
    principals: Sequence[Principal],
    protected: frozenset[str],
    grants_by_id: Mapping[int, Sequence[Grant]],
    teams_by_id: Mapping[int, Sequence[int]],
    *,
    total: int,
    limit: int,
    offset: int,
) -> UsersPage:
    """Assemble one matrix page from a page of principals and the grants/memberships fetched for
    exactly those principals. Pure (no IO), so the pagination shape is unit-tested without a DB."""
    items = [
        _user_out(p, protected, grants_by_id.get(p.id or -1, ()), teams_by_id.get(p.id or -1, ())) for p in principals
    ]
    return UsersPage(items=items, total=total, limit=limit, offset=offset)


@router.get("/users", response_model=UsersPage)
async def list_users(
    store: StoreDep,
    protected: ProtectedDep,
    limit: int = Query(PAGE_DEFAULT, ge=1, le=PAGE_MAX),
    offset: int = Query(0, ge=0),
    q: str = "",
) -> UsersPage:
    # Four queries, every one bounded by the page: the total for the query, the page of principals,
    # and the grants + memberships for exactly those principals - so an admin request never scales
    # with the whole tenant. ``q`` filters by email/name (the same case-insensitive match the
    # directory uses) so an admin reaches any user without paging through all of them.
    total = await store.count_principals(q)
    principals = await store.page_principals(needle=q, limit=limit, offset=offset)
    ids = [p.id for p in principals if p.id is not None]
    grants_by_id = await store.grants_by_principals(ids)
    teams_by_id = await store.team_ids_by_principals(ids)
    return _users_page(principals, protected, grants_by_id, teams_by_id, total=total, limit=limit, offset=offset)


@router.post("/users", response_model=UserOut)
async def create_user(body: UserCreate, store: StoreDep, protected: ProtectedDep, actor: Actor) -> UserOut:
    # A new user joins no team: membership is always explicit (add them to a team afterwards).
    try:
        principal = await store.create_principal(email=body.email, name=body.name)
    except DuplicatePrincipalError:
        raise HTTPException(status_code=422, detail=f"A user with the email {body.email!r} already exists.") from None
    audit(actor, "user_created", user_id=principal.id, email=principal.email)
    return await _one_user(store, principal, protected)


def _refuse_self(principal: Principal, actor: str, verb: str) -> None:
    if principal.email.strip().lower() == actor.strip().lower():
        raise HTTPException(status_code=409, detail=f"You cannot {verb} yourself.")


@router.patch("/users/{user_id}", response_model=UserOut)
async def set_user_admin(
    user_id: int, body: AdminFlag, store: StoreDep, protected: ProtectedDep, actor: Actor
) -> UserOut:
    principal = await store.get_principal(user_id)
    if principal is None:
        raise HTTPException(status_code=404, detail="Unknown user.")
    if not body.is_admin:
        if principal.email.lower() in protected:
            raise HTTPException(status_code=403, detail="Bootstrap administrators are protected and cannot be demoted.")
        _refuse_self(principal, actor, "demote")
    try:
        updated = await store.set_admin(user_id, body.is_admin)
    except LastAdminError:
        raise HTTPException(status_code=409, detail="The last administrator cannot be demoted.") from None
    if updated is None:
        raise HTTPException(status_code=404, detail="Unknown user.")
    # The committed flag only: a "before" read outside the store's locked transaction could be stale.
    audit(actor, "user_admin_set", user_id=user_id, email=updated.email, is_admin=updated.is_admin)
    return await _one_user(store, updated, protected)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: int, store: StoreDep, protected: ProtectedDep, actor: Actor) -> None:
    principal = await store.get_principal(user_id)
    if principal is None:
        raise HTTPException(status_code=404, detail="Unknown user.")
    if principal.email.lower() in protected:
        raise HTTPException(status_code=403, detail="Bootstrap administrators are protected and cannot be deleted.")
    _refuse_self(principal, actor, "delete")
    try:
        deleted = await store.delete_principal(user_id)
    except LastAdminError:
        raise HTTPException(status_code=409, detail="The last administrator cannot be deleted.") from None
    if not deleted:
        raise HTTPException(status_code=404, detail="Unknown user.")
    audit(actor, "user_deleted", user_id=user_id, email=principal.email, was_admin=principal.is_admin)


@router.put("/users/{user_id}/grants/{dimension}", response_model=UserOut)
async def replace_grants(
    user_id: int,
    dimension: str,
    body: GrantsReplace,
    store: StoreDep,
    catalog: CatalogDep,
    protected: ProtectedDep,
    actor: Actor,
) -> UserOut:
    """Replace a user's grants for one dimension with the given set (the matrix's per-section
    save). Read access is a value's presence; ``write`` adds write."""
    check_dimension(catalog, dimension, body.entries)
    reject_unknown_values(catalog, dimension, body.entries, store.normalize)
    replaced = await store.replace_grants(user_id, dimension, values_write(body.entries))
    if replaced is None:
        raise HTTPException(status_code=404, detail="Unknown user.")
    audit(
        actor,
        "user_grants_replaced",
        user_id=user_id,
        dimension=dimension,
        before=list(replaced.before),
        after=list(replaced.after),
    )
    principal = await store.get_principal(user_id)
    if principal is None:
        raise HTTPException(status_code=404, detail="Unknown user.")
    out = await _one_user(store, principal, protected)
    return out
