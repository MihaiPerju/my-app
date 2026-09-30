"""The access policies: the concrete implementations behind the ``AccessPolicy`` seam.

``PgAccessPolicy`` resolves a caller's ``Permissions`` from the RBAC store (grants are exact
- no tree expansion); it injects the app's dimension policy (``refinements`` and an optional
``mandatory`` gate) into every ``Permissions`` it builds, so one policy serves a pages-only
app and a multi-dimension one. ``AllowAllAccessPolicy`` is the dev/local god-mode. Both
satisfy the ``AccessPolicy`` seam Protocol structurally (async ``scope_for``), so the
composition root swaps them with no router change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from db import get_session_maker

from .domain import Permissions
from .resolve import resolve_access


@runtime_checkable
class Caller(Protocol):
    """The one thing a policy needs from an identity: the caller's email. Structural, so this
    capability never imports the concrete identity type (that lives in ``api``)."""

    email: str


@dataclass(frozen=True, slots=True)
class PgAccessPolicy:
    """Resolves a caller's permissions from the RBAC store (grants are exact).

    ``refinements`` and ``mandatory`` are the app's dimension policy, stamped onto every
    ``Permissions`` so the pure rules narrow/gate the way the app expects."""

    refinements: frozenset[str] = frozenset()
    mandatory: str | None = None

    async def scope_for(self, identity: Caller) -> Permissions:
        async with get_session_maker()() as session:
            access = await resolve_access(session, identity.email)
        if access is None:
            return Permissions(refinements=self.refinements, mandatory=self.mandatory)
        if access.is_admin:
            return Permissions(is_admin=True, refinements=self.refinements, mandatory=self.mandatory)
        return Permissions(
            read=access.read,
            write=access.write,
            refinements=self.refinements,
            mandatory=self.mandatory,
        )


@dataclass(frozen=True, slots=True)
class AllowAllAccessPolicy:
    """Dev / local god-mode: full read/write everywhere plus the admin panel, so the whole app
    (including access management) is usable with zero setup. The value is the seam, not the
    logic: prod swaps in ``PgAccessPolicy`` with no router change."""

    async def scope_for(self, identity: Caller) -> Permissions:
        return Permissions(is_admin=True, unrestricted=True)
