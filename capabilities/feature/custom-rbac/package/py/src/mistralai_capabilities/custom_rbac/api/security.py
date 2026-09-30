"""Request-time authorization: resolve the caller's permissions and gate on them.

Authentication is the ``api`` capability's job - the ``v1`` router package already applies
``require_user``, so a caller is present and active by the time these run (``get_perms`` also
depends on ``CurrentUser`` so it enforces that itself wherever it is mounted). These add
authorization: ``get_perms`` resolves the read/write boundary (honouring an admin's act-as
header), ``require_admin`` gates the admin API, and ``require_page(page)`` gates a whole page
on read permission for it.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from mistralai_capabilities.fastapi_auth.identity import CurrentUser, parse_identity

from ..domain import PAGE, Permissions
from .seams import AccessPolicy, _rbac_policy

log = logging.getLogger("access.security")

#: Admin-only header naming the user to preview the app as.
ACT_AS_HEADER = "x-act-as-email"


@dataclass(frozen=True, slots=True)
class _Caller:
    """The minimal caller the policy needs: an email to resolve grants by."""

    email: str


def _caller_email(request: Request) -> str:
    identity = parse_identity(request.headers)
    return (identity.email if identity and identity.email else "").strip()


def real_caller_email(request: Request) -> str:
    """The authenticated caller's own email, never an act-as target: the actor the audit trail names
    and the admin self-protection checks compare against."""
    return _caller_email(request)


Actor = Annotated[str, Depends(real_caller_email)]


async def resolve_effective(request: Request, policy: AccessPolicy) -> tuple[Permissions, str | None, bool]:
    """The permissions a request runs with, the impersonated email (or ``None``), and whether
    the REAL caller is an admin.

    An admin sending ``X-Act-As-Email`` for another user gets that user's permissions (resolved
    by email, so an unknown target is a valid no-access preview); a non-admin's header is ignored
    (and logged). The real identity is never changed, so every gate runs on the effective
    permissions and the audit trail still names the real caller."""
    email = _caller_email(request)
    real = await policy.scope_for(_Caller(email=email))
    target = request.headers.get(ACT_AS_HEADER, "").strip()
    if target and target.lower() != email.lower():
        if real.is_admin:
            log.info("act_as admin=%s target=%s", email, target)
            return await policy.scope_for(_Caller(email=target)), target, real.is_admin
        log.warning("act_as_denied caller=%s target=%s", email, target)
    return real, None, real.is_admin


async def get_perms(
    request: Request,
    _caller: CurrentUser,
    policy: AccessPolicy = Depends(_rbac_policy),
) -> Permissions:
    """The read/write boundary for the caller (or, for an admin using the act-as header, the
    previewed user). Every data query is narrowed by this."""
    effective, _, _ = await resolve_effective(request, policy)
    return effective


def require_admin(perms: Permissions = Depends(get_perms)) -> Permissions:
    """The caller's permissions once admin rights are confirmed, else 403. Runs on the effective
    permissions, so an admin previewing a non-admin cannot reach the admin API."""
    if not perms.is_admin:
        raise HTTPException(status_code=403, detail="Administrator access is required.")
    return perms


def require_page(page: str) -> Callable[..., Permissions]:
    """A dependency that gates a whole page on read permission for it, else 403, and returns the
    caller's permissions so the route can scope its data with the same object (FastAPI resolves
    ``get_perms`` once per request)."""

    def _dependency(perms: Permissions = Depends(get_perms)) -> Permissions:
        if not perms.can_read(PAGE, page):
            raise HTTPException(status_code=403, detail="You do not have access to this page.")
        return perms

    return _dependency


def require_tab(page: str, tab: str, *, restricted: bool) -> Callable[..., Permissions]:
    """Gate a tab under a page on read permission, else 403. A whole-page grant implies the
    page's non-restricted tabs; a ``restricted`` tab needs its own ``page:tab`` grant. The tab
    counterpart of ``require_page``.

    ``restricted`` is mandatory (keyword-only, no default): every tab route must state its tab's
    sensitivity, so a forgotten flag can never fall open and expose a sensitive tab to every
    whole-page grantee. Declare it identically on the read and write gates for the same tab."""

    def _dependency(perms: Permissions = Depends(get_perms)) -> Permissions:
        if not perms.can_read_tab(page, tab, restricted=restricted):
            raise HTTPException(status_code=403, detail="You do not have access to this tab.")
        return perms

    return _dependency


def require_tab_write(page: str, tab: str, *, restricted: bool) -> Callable[..., Permissions]:
    """Gate a mutation within a tab on WRITE permission, else 403. Write counterpart of
    ``require_tab``: a caller may read a tab without editing it. Runs on the effective
    permissions, so impersonation only ever narrows. ``restricted`` is mandatory here too, so a
    write gate cannot fall open by omitting it - keep it matching the tab's ``require_tab``."""

    def _dependency(perms: Permissions = Depends(get_perms)) -> Permissions:
        if not perms.can_write_tab(page, tab, restricted=restricted):
            raise HTTPException(status_code=403, detail="You do not have write access to this tab.")
        return perms

    return _dependency
