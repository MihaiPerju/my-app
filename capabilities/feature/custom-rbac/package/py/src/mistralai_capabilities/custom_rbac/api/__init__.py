"""The access capability's FastAPI layer: host wiring + the request-time gates.

The routers themselves live in submodules (``matrix``, ``directory``, ``me``) and are
imported by the app's ``routers/v1/access`` package, so they are only loaded inside an app
(they import the app-local ``db`` package). This module re-exports the host-facing wiring
(``install_access``, the seam Protocols) and the reusable gates so an app imports them from
one place.
"""

from .seams import AccessPolicy, CatalogEntry, CatalogProvider, install_access
from .security import (
    ACT_AS_HEADER,
    get_perms,
    require_admin,
    require_page,
    require_tab,
    require_tab_write,
    resolve_effective,
)

__all__ = [
    "ACT_AS_HEADER",
    "AccessPolicy",
    "CatalogEntry",
    "CatalogProvider",
    "get_perms",
    "install_access",
    "require_admin",
    "require_page",
    "require_tab",
    "require_tab_write",
    "resolve_effective",
]
