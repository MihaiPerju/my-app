"""The access policies (sync): the concrete implementations behind a sync app's ``AccessPolicy`` seam.

``PgAccessPolicy`` resolves a caller's ``Permissions`` from the RBAC store (grants are exact - no tree
expansion). ``AllowAllAccessPolicy`` is the dev/local god-mode. Both build the ``Permissions`` class
the app injects (``permissions``), so an app whose ``Permissions`` pre-binds its dimension policy
(refinements + an optional mandatory gate) keeps that behaviour with no policy change here. The
default is the capability's plain ``Permissions`` (pages-only). ``scope_for`` is sync, matching the
hexagonal apps this variant serves; the caller only needs an ``.email`` (structural).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from sqlalchemy import Engine
from sqlmodel import Session

from ..domain import Permissions
from .resolve import resolve_access


@runtime_checkable
class Caller(Protocol):
    """The one thing a policy needs from an identity: the caller's email. Structural, so this
    capability never imports the app's concrete identity type."""

    email: str


@dataclass(frozen=True, slots=True)
class PgAccessPolicy:
    """Resolves a caller's permissions from the RBAC store on ``engine`` (grants are exact).

    ``permissions`` is the value-object class to build - default the capability's ``Permissions``; an
    app passes its own subclass so its dimension policy (refinements/mandatory) is carried."""

    engine: Engine
    permissions: type[Permissions] = field(default=Permissions)

    def scope_for(self, identity: Caller) -> Permissions:
        with Session(self.engine) as session:
            access = resolve_access(session, identity.email)
        if access is None:
            return self.permissions()
        if access.is_admin:
            return self.permissions(is_admin=True)
        return self.permissions(read=access.read, write=access.write)


@dataclass(frozen=True, slots=True)
class AllowAllAccessPolicy:
    """Dev / local god-mode: full read/write everywhere plus the admin panel, so the whole app
    (including access management) is usable with zero setup. The value is the seam, not the logic:
    prod swaps in ``PgAccessPolicy`` with no router change."""

    permissions: type[Permissions] = field(default=Permissions)

    def scope_for(self, identity: Caller) -> Permissions:
        return self.permissions(is_admin=True, unrestricted=True)
