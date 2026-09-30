"""The env-driven default catalog: a pages-only app is grantable with no custom wiring, and an
unconfigured deployment falls back cleanly to an empty catalog."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import pytest
from fastapi import FastAPI
from mistralai_capabilities.custom_rbac.api import seams
from mistralai_capabilities.custom_rbac.api.seams import (
    CatalogEntry,
    EmptyCatalog,
    PagesCatalog,
    install_access,
    validate_catalog,
)
from mistralai_capabilities.custom_rbac.domain import PAGE


def test_pages_catalog_serves_configured_pages() -> None:
    catalog = PagesCatalog(page_ids=("home", "reports"))
    assert list(catalog.pages()) == ["home", "reports"]
    assert list(catalog.dimensions()) == []
    entries = catalog.catalog()[PAGE]
    assert [(e.value, e.label) for e in entries] == [("home", "home"), ("reports", "reports")]


def test_env_catalog_drops_repeated_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seams, "_env", lambda: type("Env", (), {"pages": ("home", "reports", "home")})())
    entries = seams._catalog_provider().catalog()[PAGE]
    assert [e.value for e in entries] == ["home", "reports"]


def test_env_catalog_rejects_a_page_colliding_with_a_tab_code(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seams, "_env", lambda: type("Env", (), {"pages": ("settings:billing",)})())
    with pytest.raises(ValueError):
        seams._catalog_provider()


def test_pages_catalog_is_empty_when_unconfigured() -> None:
    catalog = PagesCatalog()
    assert list(catalog.pages()) == []
    assert catalog.catalog() == {}


def test_empty_catalog_grants_nothing() -> None:
    catalog = EmptyCatalog()
    assert list(catalog.pages()) == []
    assert list(catalog.dimensions()) == []
    assert catalog.catalog() == {}


def test_default_catalogs_expose_no_tabs() -> None:
    # The zero-config catalogs are pages-only: apps that want tabs supply their own provider.
    assert PagesCatalog(page_ids=("home",)).tabs() == {}
    assert EmptyCatalog().tabs() == {}


@dataclass(frozen=True)
class _Catalog:
    page_ids: tuple[str, ...]
    tab_map: Mapping[str, Sequence[str]] = field(default_factory=dict)
    page_values: tuple[str, ...] = ()

    def pages(self) -> Sequence[str]:
        return self.page_ids

    def dimensions(self) -> Sequence[str]:
        return ()

    def catalog(self) -> Mapping[str, Sequence[CatalogEntry]]:
        return {PAGE: [CatalogEntry(value=v, label=v) for v in self.page_values]}

    def tabs(self) -> Mapping[str, Sequence[str]]:
        return self.tab_map


def test_valid_custom_catalog_is_installed() -> None:
    app = FastAPI()
    catalog = _Catalog(("settings",), {"settings": ["settings:billing"]}, ("settings", "settings:billing"))
    install_access(app, catalog=catalog)
    assert len(app.dependency_overrides) == 1


@pytest.mark.parametrize(
    "catalog",
    [
        _Catalog(("settings", "settings:billing")),
        _Catalog(("settings",), {"reports": ["reports:x"]}),
        _Catalog(("settings",), {"settings": ["other:billing"]}),
        _Catalog(("settings",), {"settings": ["settings:a:b"]}),
        _Catalog(("settings",), {"settings": ["settings:"]}),
        _Catalog(("settings",), page_values=("settings:billing",)),
        _Catalog(("settings",), page_values=()),
        _Catalog(("settings",), {"settings": ["settings:billing"]}, ("settings",)),
        _Catalog(("settings",), page_values=("settings", "settings")),
    ],
)
def test_colliding_custom_catalog_is_rejected(catalog: _Catalog) -> None:
    with pytest.raises(ValueError):
        validate_catalog(catalog)
    app = FastAPI()
    with pytest.raises(ValueError):
        install_access(app, catalog=catalog)
    assert app.dependency_overrides == {}


@pytest.mark.parametrize("dimension", ["cost/center", "cost center", "", "a?b"])
def test_route_breaking_dimension_is_rejected(dimension: str) -> None:
    @dataclass(frozen=True)
    class _Dimensioned(_Catalog):
        def dimensions(self) -> Sequence[str]:
            return (dimension,)

    with pytest.raises(ValueError, match="URL path segment"):
        validate_catalog(_Dimensioned(("home",), page_values=("home",)))


def test_route_safe_dimensions_are_accepted() -> None:
    @dataclass(frozen=True)
    class _Dimensioned(_Catalog):
        def dimensions(self) -> Sequence[str]:
            return ("cost_center", "legal-entity")

    catalog = _Dimensioned(("home",), page_values=("home",))
    assert validate_catalog(catalog) is catalog
