"""``ensure_bootstrap`` against an in-memory fake store: it creates missing admins, restores a
demoted one, and never re-inserts a case-insensitive duplicate from the configured list."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

import pytest
from mistralai_capabilities.custom_rbac.bootstrap import ensure_bootstrap
from mistralai_capabilities.custom_rbac.store import DuplicatePrincipalError


@dataclass
class _FakePrincipal:
    id: int
    email: str
    is_admin: bool


@dataclass
class _FakeStore:
    """Duck-types the slice of ``RbacStore`` bootstrap uses, with the real store's folded-uniqueness
    guard so a second insert of the same email (any case) is a hard failure, not a silent second row."""

    principals: list[_FakePrincipal] = field(default_factory=list)
    _next_id: int = 1

    lookups: list[list[str]] = field(default_factory=list)

    async def principals_by_emails(self, emails: list[str]) -> list[_FakePrincipal]:
        self.lookups.append(list(emails))
        folded = {e.lower() for e in emails}
        return [p for p in self.principals if p.email.lower() in folded]

    racing: list[_FakePrincipal] = field(default_factory=list)

    async def admin_emails(self) -> frozenset[str]:
        return frozenset(p.email for p in self.principals if p.is_admin)

    async def create_principal(self, *, email: str, name: str, is_admin: bool = False) -> _FakePrincipal:
        if self.racing:
            # A concurrent init run wins the insert between our read and our write.
            self.principals.append(self.racing.pop())
            raise DuplicatePrincipalError(email)
        if any(p.email.lower() == email.strip().lower() for p in self.principals):
            raise AssertionError(f"duplicate insert attempted for {email!r}")
        principal = _FakePrincipal(id=self._next_id, email=email.strip(), is_admin=is_admin)
        self._next_id += 1
        self.principals.append(principal)
        return principal

    async def set_admin(self, principal_id: int, is_admin: bool) -> _FakePrincipal | None:
        for principal in self.principals:
            if principal.id == principal_id:
                principal.is_admin = is_admin
                return principal
        return None


def test_creates_missing_admin() -> None:
    store = _FakeStore()
    asyncio.run(ensure_bootstrap(store, ["a@x.io"]))
    assert [(p.email, p.is_admin) for p in store.principals] == [("a@x.io", True)]


def test_case_insensitive_duplicates_create_once() -> None:
    store = _FakeStore()
    asyncio.run(ensure_bootstrap(store, ["a@x.io", "A@x.io", " a@x.io "]))
    assert len(store.principals) == 1


def test_restores_a_demoted_admin() -> None:
    store = _FakeStore(principals=[_FakePrincipal(id=1, email="a@x.io", is_admin=False)])
    asyncio.run(ensure_bootstrap(store, ["a@x.io"]))
    assert store.principals[0].is_admin is True


def test_blank_entries_are_skipped() -> None:
    store = _FakeStore()
    asyncio.run(ensure_bootstrap(store, ["", "   "]))
    assert store.principals == []


def test_looks_up_only_configured_admins_once() -> None:
    store = _FakeStore(principals=[_FakePrincipal(id=1, email="other@x.io", is_admin=False)])
    asyncio.run(ensure_bootstrap(store, ["a@x.io", " a@x.io", "b@x.io", ""]))
    assert store.lookups == [["a@x.io", "b@x.io"]]
    assert store.principals[0].is_admin is False


def test_a_concurrent_insert_is_adopted_and_promoted() -> None:
    store = _FakeStore(racing=[_FakePrincipal(id=7, email="a@x.io", is_admin=False)])
    asyncio.run(ensure_bootstrap(store, ["a@x.io"]))
    assert [(p.id, p.is_admin) for p in store.principals] == [(7, True)]


def test_warns_when_nobody_is_admin(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING):
        asyncio.run(ensure_bootstrap(_FakeStore(), []))
    assert "no_admin" in caplog.text
