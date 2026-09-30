"""The sync store's admin guardrails and adoption safety nets, plus the team-union semantics the
resolver pins: the last admin can never be demoted or deleted, a legacy case-duplicate email
resolves deterministically and is reported, and grants union per dimension across grant sources."""

from __future__ import annotations

import logging

import pytest
from mistralai_capabilities.custom_rbac.sync import (
    LastAdminError,
    Principal,
    RbacStore,
    ensure_bootstrap,
    metadata,
    resolve_access,
)
from mistralai_capabilities.custom_rbac.sync.store import Session
from sqlalchemy.pool import StaticPool
from sqlmodel import create_engine

ENTITY = "entity"
COST_CENTER = "cost_center"


def _store() -> RbacStore:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    metadata.create_all(engine)
    return RbacStore(engine)


def test_the_last_admin_cannot_be_demoted_or_deleted() -> None:
    store = _store()
    only = store.create_principal(email="root@x.io", name="", is_admin=True)
    assert only.id is not None
    with pytest.raises(LastAdminError):
        store.set_admin(only.id, False)
    with pytest.raises(LastAdminError):
        store.delete_principal(only.id)
    second = store.create_principal(email="two@x.io", name="", is_admin=True)
    assert second.id is not None
    assert store.set_admin(only.id, False) is not None
    with pytest.raises(LastAdminError):
        store.delete_principal(second.id)


def test_non_admins_are_unaffected_by_the_admin_guard() -> None:
    store = _store()
    store.create_principal(email="root@x.io", name="", is_admin=True)
    user = store.create_principal(email="u@x.io", name="")
    assert user.id is not None
    assert store.set_admin(user.id, False) is not None
    assert store.delete_principal(user.id) is True


def test_a_case_duplicate_resolves_to_the_oldest_row_and_is_reported(caplog: pytest.LogCaptureFixture) -> None:
    store = _store()
    with Session(store.engine) as s:
        s.add(Principal(email="dup@x.io", name="old", is_admin=True))
        s.add(Principal(email="DUP@x.io", name="new", is_admin=False))
        s.commit()
    with Session(store.engine) as s:
        access = resolve_access(s, "Dup@X.io")
    assert access is not None and access.is_admin is True
    assert store.case_duplicate_emails() == ["dup@x.io"]
    with caplog.at_level(logging.ERROR):
        ensure_bootstrap(store, [])
    assert "case_duplicate_principals" in caplog.text


def test_bootstrap_warns_when_no_admin_exists(caplog: pytest.LogCaptureFixture) -> None:
    store = _store()
    with caplog.at_level(logging.WARNING):
        ensure_bootstrap(store, [])
    assert "no_admin" in caplog.text


def test_grants_union_per_dimension_across_teams() -> None:
    # Characterization, not an endorsement: grants are flattened into one union per dimension, so a
    # refinement granted by one team also narrows the entity another team granted without it.
    store = _store()
    user = store.create_principal(email="u@x.io", name="")
    a = store.create_team(name="A")
    b = store.create_team(name="B")
    assert user.id is not None and a.id is not None and b.id is not None
    store.replace_team_grants(a.id, ENTITY, {"FR10": False})
    store.replace_team_grants(b.id, ENTITY, {"DE20": False})
    store.replace_team_grants(b.id, COST_CENTER, {"BUS1": False})
    store.add_team_member(a.id, user.id)
    store.add_team_member(b.id, user.id)
    with Session(store.engine) as s:
        access = resolve_access(s, "u@x.io")
    assert access is not None
    assert access.read == {ENTITY: frozenset({"FR10", "DE20"}), COST_CENTER: frozenset({"BUS1"})}
