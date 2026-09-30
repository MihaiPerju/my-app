"""Host seams for the access API: the policy, the store, the catalog, and the protected admins.

By default these **self-initialize from `env.access` + the app's `db`**, so the capability is
drop-in: selecting it wires the routes (file discovery) and these seams resolve a working RBAC setup
with no `create_app` changes. `CUSTOM_RBAC_POLICY=pg` reads per-user grants; `allow_all` is dev god-mode.

An app that needs a custom dimension catalog (grantable values per dimension, e.g. finance entities)
or a bespoke policy calls `install_access(app, ...)` to override any default - the same
`dependency_overrides` mechanism the `api` capability's `install_default_stores` uses. Everything is
optional; nothing raises.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cache
from typing import Annotated, Protocol, runtime_checkable

from fastapi import Depends, FastAPI

from ..domain import PAGE, TAB_SEP, Permissions, validate_page_id
from ..policy import AllowAllAccessPolicy, PgAccessPolicy
from ..store import RbacStore

log = logging.getLogger("access.seams")


@runtime_checkable
class AccessPolicy(Protocol):
    """Resolves the permissions an identity is allowed (the caller carries ``.email``)."""

    async def scope_for(self, identity: object) -> Permissions: ...


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """One grantable value for a dimension, plus a human label for the admin matrix."""

    value: str
    label: str


@runtime_checkable
class CatalogProvider(Protocol):
    """The app's grantable vocabulary: its pages, its data dimensions, and the values per dimension
    the admin matrix may grant. The dimension names and values are the app's domain, not the
    capability's, so an app with dimensions supplies its own via ``install_access``.

    ``tabs`` maps a page to its tab values (namespaced ``page:tab`` codes, see ``domain.tab_value``)
    so the matrix can render tabs nested under their page with a select-all that cascades; a page
    with no tabs is simply absent. Tabs are still values of the ``PAGE`` dimension, so their labels
    live in ``catalog()[PAGE]`` alongside the pages and enforcement needs no new dimension."""

    def pages(self) -> Sequence[str]: ...
    def dimensions(self) -> Sequence[str]: ...
    def catalog(self) -> Mapping[str, Sequence[CatalogEntry]]: ...
    def tabs(self) -> Mapping[str, Sequence[str]]: ...


@dataclass(frozen=True, slots=True)
class EmptyCatalog:
    """No pages, no dimensions. The admin matrix renders empty; grant enforcement still works for any
    dimension a route gates on. Install it explicitly via ``install_access`` for an app that grants
    nothing through the matrix; the env-driven default is ``PagesCatalog``."""

    def pages(self) -> Sequence[str]:
        return ()

    def dimensions(self) -> Sequence[str]:
        return ()

    def catalog(self) -> Mapping[str, Sequence[CatalogEntry]]:
        return {}

    def tabs(self) -> Mapping[str, Sequence[str]]:
        return {}


@dataclass(frozen=True, slots=True)
class PagesCatalog:
    """The zero-config default: serves the ``page`` dimension from a configured page list
    (env ``CUSTOM_RBAC_PAGES``), so a pages-only app can grant access with no custom wiring. It advertises
    no data dimensions; an app with dimensions installs a richer ``CatalogProvider`` via
    ``install_access``."""

    page_ids: tuple[str, ...] = ()

    def pages(self) -> Sequence[str]:
        return self.page_ids

    def dimensions(self) -> Sequence[str]:
        return ()

    def catalog(self) -> Mapping[str, Sequence[CatalogEntry]]:
        if not self.page_ids:
            return {}
        return {PAGE: [CatalogEntry(value=page, label=page) for page in self.page_ids]}

    def tabs(self) -> Mapping[str, Sequence[str]]:
        return {}


# A dimension is one URL path segment of the grant-replace routes, so it must survive routing verbatim.
_DIMENSION = re.compile(r"[A-Za-z0-9_-]+")


@cache
def _env() -> object:
    from env.custom_rbac import env  # app-local; shipped by this capability's template

    return env


@cache
def _warn_allow_all() -> None:
    log.warning("rbac_policy_allow_all: every authenticated caller is an admin; dev only, never deploy")


def _rbac_policy() -> AccessPolicy:
    env = _env()
    if getattr(env, "custom_rbac_policy", "pg") == "allow_all":
        _warn_allow_all()
        return AllowAllAccessPolicy()
    return PgAccessPolicy()


def _rbac_store() -> RbacStore:
    return RbacStore()


def _catalog_provider() -> CatalogProvider:
    # Validate at the boundary: a page id containing the reserved `:` would collide with a tab code
    # (see domain.validate_page_id), so reject it here rather than let a page grant open a restricted tab.
    # A page repeated in CUSTOM_RBAC_PAGES is an operator slip, not a collision: keep its first occurrence.
    page_ids = tuple(dict.fromkeys(validate_page_id(p) for p in getattr(_env(), "pages", ())))
    return validate_catalog(PagesCatalog(page_ids=page_ids))


def _protected_emails() -> frozenset[str]:
    return frozenset(e.lower() for e in getattr(_env(), "bootstrap_admins", ()))


def validate_catalog(catalog: CatalogProvider) -> CatalogProvider:
    """Reject a catalog whose page ids could collide with a tab code: every page id must be free of the
    reserved ``:``, every tab must hang off a declared page as ``page:tab``, and every ``PAGE`` catalog
    value must be one of those. Without this a custom page named ``settings:billing`` would receive a
    plain page grant byte-identical to the restricted ``billing`` tab grant under ``settings``. The
    other direction holds too: every declared page and tab has its ``PAGE`` catalog entry (else the
    matrix could never grant it), and no dimension lists a value twice. Dimension names must be
    route-safe (letters, digits, ``_``, ``-``): the grant-replace routes carry them as a path segment."""
    for dimension in {*catalog.dimensions(), *catalog.catalog()}:
        if not _DIMENSION.fullmatch(dimension):
            raise ValueError(f"dimension {dimension!r} must match {_DIMENSION.pattern} (it is a URL path segment)")
    pages = {validate_page_id(page) for page in catalog.pages()}
    tabs: set[str] = set()
    for page, values in getattr(catalog, "tabs", dict)().items():
        if page not in pages:
            raise ValueError(f"tabs declared for an unknown page: {page!r}")
        for value in values:
            head, sep, tab = value.partition(TAB_SEP)
            if head != page or not sep or not tab or TAB_SEP in tab:
                raise ValueError(f"tab value {value!r} is not a {page}{TAB_SEP}<tab> code")
            tabs.add(value)
    for dimension, entries in catalog.catalog().items():
        values = [entry.value for entry in entries]
        duplicates = sorted({v for v in values if values.count(v) > 1})
        if duplicates:
            raise ValueError(f"{dimension!r} catalog repeats values: {duplicates}")
    listed = {entry.value for entry in catalog.catalog().get(PAGE, ())}
    unknown = listed - pages - tabs
    if unknown:
        raise ValueError(f"{PAGE} catalog values are neither declared pages nor tabs: {sorted(unknown)}")
    missing = (pages | tabs) - listed
    if missing:
        raise ValueError(f"declared pages/tabs missing from the {PAGE} catalog (ungrantable): {sorted(missing)}")
    return catalog


PolicyDep = Annotated[AccessPolicy, Depends(_rbac_policy)]
StoreDep = Annotated[RbacStore, Depends(_rbac_store)]
CatalogDep = Annotated[CatalogProvider, Depends(_catalog_provider)]
ProtectedDep = Annotated[frozenset[str], Depends(_protected_emails)]


def install_access(
    app: FastAPI,
    *,
    policy: AccessPolicy | None = None,
    store: RbacStore | None = None,
    catalog: CatalogProvider | None = None,
    protected_emails: Sequence[str] | None = None,
) -> None:
    """Override any env-derived default. All optional - the capability works without this call.

    Pass ``catalog`` to expose the app's grantable vocabulary (pages + dimension values), ``policy``
    for a bespoke ``AccessPolicy`` (e.g. a dimension policy with ``refinements``/``mandatory``), and
    ``protected_emails`` to lock specific admins in the matrix."""
    # Validate everything before touching the app, so a rejected configuration never leaves a
    # partially installed set of overrides behind.
    validated = validate_catalog(catalog) if catalog is not None else None
    if policy is not None:
        app.dependency_overrides[_rbac_policy] = lambda: policy
    if store is not None:
        app.dependency_overrides[_rbac_store] = lambda: store
    if validated is not None:
        app.dependency_overrides[_catalog_provider] = lambda: validated
    if protected_emails is not None:
        pe = frozenset(e.strip().lower() for e in protected_emails if e.strip())
        app.dependency_overrides[_protected_emails] = lambda: pe
