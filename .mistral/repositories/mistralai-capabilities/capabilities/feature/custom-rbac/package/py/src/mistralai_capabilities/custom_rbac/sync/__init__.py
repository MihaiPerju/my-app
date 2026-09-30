"""The RBAC capability's **sync** data substrate, for hexagonal apps that run sync SQLModel.

A sync app adopts this to REPLACE its own in-repo RBAC data layer: the SQLModel tables (``models``),
the read-side resolver the access policy calls (``resolve``), the admin-matrix write store
(``store``), the concrete access policies (``policy``), and the idempotent admin bootstrap
(``bootstrap``). Everything is standalone - it takes an injected ``Engine`` and (for the policy) the
app's ``Permissions`` class, and imports no app-local ``db`` package and no sibling identity
capability - so it drops into a hexagonal app that owns its own identity ports and composition root.

The app keeps its own HTTP routers and dimension vocabulary; this package is only the data substrate.
The greenfield async ``postgres``/``api`` stack uses the sibling async modules + ``template`` instead.
"""

from .bootstrap import ensure_bootstrap
from .models import Grant, Principal, Team, TeamGrant, TeamMembership, metadata
from .policy import AllowAllAccessPolicy, Caller, PgAccessPolicy
from .resolve import ResolvedAccess, resolve_access
from .store import (
    DuplicatePrincipalError,
    DuplicateTeamError,
    LastAdminError,
    Normalizer,
    RbacStore,
)

__all__ = [
    "AllowAllAccessPolicy",
    "Caller",
    "DuplicatePrincipalError",
    "DuplicateTeamError",
    "Grant",
    "LastAdminError",
    "Normalizer",
    "PgAccessPolicy",
    "Principal",
    "RbacStore",
    "ResolvedAccess",
    "Team",
    "TeamGrant",
    "TeamMembership",
    "ensure_bootstrap",
    "metadata",
    "resolve_access",
]
