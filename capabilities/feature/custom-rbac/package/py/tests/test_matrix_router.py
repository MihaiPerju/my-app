"""The admin matrix over HTTP with an in-memory store: the self/last-admin guardrails, the purge
path for grants the catalog dropped, write-wins on duplicate entries, and the audit trail naming
the real caller (never an act-as target)."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi_auth.identity import HEADER_USER_EMAIL, HEADER_USER_ID
from mistralai_capabilities.fastapi_auth.identity.store import _user_store
from mistralai_capabilities.custom_rbac.api.matrix import router
from mistralai_capabilities.custom_rbac.api.seams import PagesCatalog, install_access
from mistralai_capabilities.custom_rbac.api.security import ACT_AS_HEADER
from mistralai_capabilities.custom_rbac.domain import Permissions
from mistralai_capabilities.custom_rbac.store import GrantsReplaced, LastAdminError


@dataclass
class _Row:
    id: int
    email: str
    is_admin: bool = False
    name: str = ""


@dataclass
class _Grant:
    dimension: str
    value: str
    write: bool


@dataclass
class _Store:
    rows: dict[int, _Row] = field(default_factory=dict)
    grants: dict[int, list[_Grant]] = field(default_factory=dict)
    replaced: list[Mapping[str, bool]] = field(default_factory=list)

    @staticmethod
    def normalize(value: str, dimension: str) -> str:
        return value.strip()

    async def get_principal(self, principal_id: int) -> _Row | None:
        return self.rows.get(principal_id)

    async def set_admin(self, principal_id: int, is_admin: bool) -> _Row | None:
        admins = {r.id for r in self.rows.values() if r.is_admin}
        if not is_admin and admins == {principal_id}:
            raise LastAdminError(principal_id)
        row = self.rows.get(principal_id)
        if row is not None:
            row.is_admin = is_admin
        return row

    async def delete_principal(self, principal_id: int) -> bool:
        if {r.id for r in self.rows.values() if r.is_admin} == {principal_id}:
            raise LastAdminError(principal_id)
        return self.rows.pop(principal_id, None) is not None

    async def list_grants(self, principal_id: int) -> list[_Grant]:
        return list(self.grants.get(principal_id, []))

    async def team_ids_for(self, principal_id: int) -> list[int]:
        return []

    async def replace_grants(
        self, principal_id: int, dimension: str, values_write: Mapping[str, bool]
    ) -> GrantsReplaced | None:
        if principal_id not in self.rows:
            return None
        self.replaced.append(dict(values_write))
        section = [g for g in self.grants.get(principal_id, []) if g.dimension == dimension]
        kept = [g for g in self.grants.get(principal_id, []) if g.dimension != dimension]
        self.grants[principal_id] = kept + [_Grant(dimension, v, w) for v, w in values_write.items()]
        return GrantsReplaced(
            before=tuple(sorted(f"{g.value}:w" if g.write else g.value for g in section)),
            after=tuple(sorted(f"{v}:w" if w else v for v, w in values_write.items())),
        )


@dataclass(frozen=True)
class _Policy:
    admins: frozenset[str]

    async def scope_for(self, identity: object) -> Permissions:
        return Permissions(is_admin=getattr(identity, "email", "").lower() in self.admins)


@dataclass
class _Users:
    async def upsert(self, *, user_id: str, email: str | None) -> object:
        return type("U", (), {"user_id": user_id, "is_active": True})()


ROOT, OTHER, BOSS, USER = 1, 2, 3, 4


def _client(store: _Store) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    install_access(
        app,
        policy=_Policy(frozenset({"root@x.io", "other@x.io", "boss@x.io"})),
        store=store,  # type: ignore[arg-type]
        catalog=PagesCatalog(page_ids=("home", "reports")),
        protected_emails=["boss@x.io"],
    )
    app.dependency_overrides[_user_store] = _Users
    return TestClient(app)


def _as(email: str, **extra: str) -> dict[str, str]:
    return {HEADER_USER_ID: email, HEADER_USER_EMAIL: email, **extra}


def _store() -> _Store:
    return _Store(
        rows={
            ROOT: _Row(ROOT, "root@x.io", is_admin=True),
            OTHER: _Row(OTHER, "other@x.io", is_admin=True),
            BOSS: _Row(BOSS, "boss@x.io", is_admin=True),
            USER: _Row(USER, "user@x.io"),
        }
    )


def test_non_admin_is_refused() -> None:
    client = _client(_store())
    assert client.delete(f"/admin/users/{USER}", headers=_as("user@x.io")).status_code == 403
    assert client.patch(f"/admin/users/{USER}", json={"is_admin": True}, headers=_as("user@x.io")).status_code == 403


def test_an_admin_cannot_demote_or_delete_themselves() -> None:
    client = _client(_store())
    assert client.patch(f"/admin/users/{ROOT}", json={"is_admin": False}, headers=_as("root@x.io")).status_code == 409
    assert client.delete(f"/admin/users/{ROOT}", headers=_as("ROOT@x.io")).status_code == 409


def test_protected_admins_stay_protected() -> None:
    client = _client(_store())
    assert client.patch(f"/admin/users/{BOSS}", json={"is_admin": False}, headers=_as("root@x.io")).status_code == 403
    assert client.delete(f"/admin/users/{BOSS}", headers=_as("root@x.io")).status_code == 403


def test_the_last_admin_cannot_be_removed() -> None:
    store = _Store(rows={ROOT: _Row(ROOT, "root@x.io", is_admin=True), OTHER: _Row(OTHER, "other@x.io")})
    client = _client(store)
    # `other` is not an admin in the store, but the fake policy still lets it reach the admin API.
    assert client.patch(f"/admin/users/{ROOT}", json={"is_admin": False}, headers=_as("other@x.io")).status_code == 409
    assert client.delete(f"/admin/users/{ROOT}", headers=_as("other@x.io")).status_code == 409


def test_duplicate_entries_resolve_write_wins() -> None:
    store = _store()
    body = {"entries": [{"value": "home", "write": True}, {"value": "home", "write": False}]}
    assert (
        _client(store).put(f"/admin/users/{USER}/grants/page", json=body, headers=_as("root@x.io")).status_code == 200
    )
    assert store.replaced == [{"home": True}]


def test_a_dimension_the_catalog_dropped_can_only_be_purged() -> None:
    store = _store()
    store.grants[USER] = [_Grant("region", "EU", False)]
    client = _client(store)
    kept = client.put(
        f"/admin/users/{USER}/grants/region", json={"entries": [{"value": "EU"}]}, headers=_as("root@x.io")
    )
    assert kept.status_code == 422
    purged = client.put(f"/admin/users/{USER}/grants/region", json={"entries": []}, headers=_as("root@x.io"))
    assert purged.status_code == 200
    assert store.grants[USER] == []


def test_an_uncataloged_value_is_rejected() -> None:
    body = {"entries": [{"value": "secret"}]}
    assert (
        _client(_store()).put(f"/admin/users/{USER}/grants/page", json=body, headers=_as("root@x.io")).status_code
        == 422
    )


def test_audit_names_the_real_caller_not_the_act_as_target(caplog: pytest.LogCaptureFixture) -> None:
    client = _client(_store())
    with caplog.at_level(logging.INFO, logger="access.audit"):
        response = client.put(
            f"/admin/users/{USER}/grants/page",
            json={"entries": [{"value": "home", "write": True}]},
            headers=_as("root@x.io", **{ACT_AS_HEADER: "other@x.io"}),
        )
    assert response.status_code == 200
    [record] = [r for r in caplog.records if r.name == "access.audit"]
    event = record.rbac_audit  # type: ignore[attr-defined]
    assert event["actor"] == "root@x.io"
    assert event["action"] == "user_grants_replaced"
    assert event["before"] == [] and event["after"] == ["home:w"]


def test_install_access_rejects_a_bad_catalog_without_partial_overrides() -> None:
    app = FastAPI()
    with pytest.raises(ValueError):
        install_access(app, store=_store(), catalog=PagesCatalog(page_ids=("settings:billing",)))  # type: ignore[arg-type]
    assert app.dependency_overrides == {}
