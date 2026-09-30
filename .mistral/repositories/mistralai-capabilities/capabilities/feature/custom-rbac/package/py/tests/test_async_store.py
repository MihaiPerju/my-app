"""The async store and resolver against a real (SQLite) database: case-folded uniqueness, the
admin guardrails, write-wins grant replacement, delete cascades, and team-unioned resolution.
Skipped where ``aiosqlite`` is not installed; row locks are Postgres-only and not exercised here."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import pytest

pytest.importorskip("aiosqlite")

from db.models.custom_rbac import Grant, Principal, Team, TeamGrant, TeamMembership
from mistralai_capabilities.custom_rbac import policy as policy_module
from mistralai_capabilities.custom_rbac import store as store_module
from mistralai_capabilities.custom_rbac.policy import PgAccessPolicy
from mistralai_capabilities.custom_rbac.store import (
    DuplicatePrincipalError,
    DuplicateTeamError,
    LastAdminError,
    RbacStore,
)
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel


def _run(monkeypatch: pytest.MonkeyPatch, scenario: Callable[[RbacStore], Awaitable[None]]) -> None:
    async def main() -> None:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")

        @event.listens_for(engine.sync_engine, "connect")
        def _fk(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        async with engine.begin() as connection:
            # Only the rbac tables: a generated app's metadata also carries Postgres-only types.
            tables = [m.__table__ for m in (Principal, Grant, Team, TeamMembership, TeamGrant)]
            await connection.run_sync(lambda sync: SQLModel.metadata.create_all(sync, tables=tables))
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        monkeypatch.setattr(store_module, "get_session_maker", lambda: maker)
        monkeypatch.setattr(policy_module, "get_session_maker", lambda: maker)
        try:
            await scenario(RbacStore())
        finally:
            await engine.dispose()

    asyncio.run(main())


def test_case_insensitive_uniqueness(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario(store: RbacStore) -> None:
        await store.create_principal(email="Alice@x.io", name="A")
        with pytest.raises(DuplicatePrincipalError):
            await store.create_principal(email="alice@X.io", name="dup")
        await store.create_team(name="Finance")
        with pytest.raises(DuplicateTeamError):
            await store.create_team(name="finance")

    _run(monkeypatch, scenario)


def test_last_admin_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario(store: RbacStore) -> None:
        root = await store.create_principal(email="root@x.io", name="", is_admin=True)
        assert root.id is not None
        with pytest.raises(LastAdminError):
            await store.set_admin(root.id, False)
        with pytest.raises(LastAdminError):
            await store.delete_principal(root.id)
        await store.create_principal(email="two@x.io", name="", is_admin=True)
        assert (await store.set_admin(root.id, False)) is not None
        assert await store.delete_principal(root.id) is True

    _run(monkeypatch, scenario)


def test_grants_replace_write_wins_and_resolve_unions_teams(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario(store: RbacStore) -> None:
        user = await store.create_principal(email="u@x.io", name="")
        team = await store.create_team(name="T")
        assert user.id is not None and team.id is not None
        replaced = await store.replace_grants(user.id, "page", {"home": False, " home ": True})
        assert replaced is not None and replaced.before == () and replaced.after == ("home:w",)
        again = await store.replace_grants(user.id, "page", {"reports": False})
        assert again is not None and again.before == ("home:w",) and again.after == ("reports",)
        await store.replace_grants(user.id, "page", {"home": True})
        assert [(g.value, g.write) for g in await store.list_grants(user.id)] == [("home", True)]
        await store.replace_team_grants(team.id, "page", {"reports": False})
        added = await store.add_team_member(team.id, user.id)
        assert added is not None and added.added == (user.id,)
        again = await store.add_team_member(team.id, user.id)
        assert again is not None and not again.added
        perms = await PgAccessPolicy().scope_for(type("C", (), {"email": "U@X.io"})())
        assert perms.can_read("page", "home") and perms.can_write("page", "home")
        assert perms.can_read("page", "reports") and not perms.can_write("page", "reports")

    _run(monkeypatch, scenario)


def test_delete_cascades_and_unknown_ids_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario(store: RbacStore) -> None:
        await store.create_principal(email="root@x.io", name="", is_admin=True)
        user = await store.create_principal(email="u@x.io", name="")
        team = await store.create_team(name="T")
        assert user.id is not None and team.id is not None
        await store.replace_grants(user.id, "page", {"home": False})
        await store.add_team_member(team.id, user.id)
        assert await store.delete_principal(user.id) is True
        assert await store.count_team_members(team.id) == 0
        assert await store.add_team_member(team.id, 999) is None
        assert await store.replace_grants(999, "page", {"home": False}) is None
        assert (await store.principals_by_emails(["ROOT@x.io"]))[0].email == "root@x.io"
        assert isinstance((await store.list_principals())[0], Principal)

    _run(monkeypatch, scenario)


def test_membership_edits_report_only_committed_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario(store: RbacStore) -> None:
        user = await store.create_principal(email="u@x.io", name="")
        team = await store.create_team(name="T")
        assert user.id is not None and team.id is not None
        replaced = await store.replace_team_members(team.id, [user.id, 999, user.id])
        assert replaced is not None and replaced.added == (user.id,) and replaced.removed == ()
        cleared = await store.replace_team_members(team.id, [])
        assert cleared is not None and cleared.added == () and cleared.removed == (user.id,)
        absent = await store.remove_team_member(team.id, user.id)
        assert absent is not None and not absent.removed
        assert await store.replace_team_members(999, [user.id]) is None

    _run(monkeypatch, scenario)
