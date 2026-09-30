"""``/me``: the caller's own authorization, so the frontend can gate nav + write actions.

Returns the effective permissions (honouring an admin's act-as header) as plain data:
``is_admin``/``unrestricted`` for the bypass cases, else the granted read/write values per
dimension. No admin rights required - every caller may read their own boundary.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from mistralai_capabilities.fastapi_auth.identity import CurrentUser, parse_identity

from .schemas import MeOut
from .seams import AccessPolicy, _rbac_policy
from .security import resolve_effective

router = APIRouter(tags=["access"])


@router.get("/me", response_model=MeOut)
async def read_me(
    request: Request,
    _caller: CurrentUser,
    policy: AccessPolicy = Depends(_rbac_policy),
) -> MeOut:
    perms, acting_as, _ = await resolve_effective(request, policy)
    identity = parse_identity(request.headers)
    real_email = identity.email if identity and identity.email else ""
    return MeOut(
        email=acting_as or real_email,
        is_admin=perms.is_admin,
        unrestricted=perms.unrestricted,
        acting_as=acting_as,
        read={dimension: sorted(values) for dimension, values in perms.read.items()},
        write={dimension: sorted(values) for dimension, values in perms.write.items()},
    )
