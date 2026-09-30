"""The ``access`` capability's published core: the pure authorization domain.

Framework-free and ORM-free. The Postgres-backed policy, the SQLModel tables and
the FastAPI wiring (admin/users routers + dependency factories) live in this
capability's ``template/`` because they import the app's ``db`` package and
FastAPI; keeping them out of this dist keeps it safe for a worker to install.
"""

from .domain import (
    PAGE,
    UNRESTRICTED,
    Permissions,
    is_denied,
    scoped_codes,
    tab_value,
)

__all__ = [
    "PAGE",
    "UNRESTRICTED",
    "Permissions",
    "is_denied",
    "scoped_codes",
    "tab_value",
]
