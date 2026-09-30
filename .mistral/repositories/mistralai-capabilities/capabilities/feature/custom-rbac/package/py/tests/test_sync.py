"""The sync data substrate end to end on an in-memory SQLite engine: models create, the store's
matrix CRUD, ``resolve_access`` (direct + team-inherited grants, case-insensitive, admin bypass),
the policies (including a caller-injected ``Permissions`` subclass carrying its dimension policy),
and the idempotent bootstrap. This is the contract a sync hexagonal app adopts in place of its own.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from mistralai_capabilities.custom_rbac.domain import Permissions
from mistralai_capabilities.custom_rbac.sync import (
    AllowAllAccessPolicy,
    DuplicatePrincipalError,
    DuplicateTeamError,
    PgAccessPolicy,
    RbacStore,
    ensure_bootstrap,
    metadata,
    resolve_access,
)
from mistralai_capabilities.custom_rbac.sync.store import Session
from sqlalchemy.pool import StaticPool
from sqlmodel import create_engine


@dataclass(frozen=True)
class _Caller:
    email: str


ENTITY = "entity"
COST_CENTER = "cost_center"


def _engine():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    metadata.create_all(engine)
    return engine


def _entity_upper(value: str, dimension: str) -> str:
    value = value.strip()
    return value.upper() if dimension == ENTITY else value


def test_store_crud_and_resolution_direct_and_via_team() -> None:
    engine = _engine()
    store = RbacStore(engine, normalize=_entity_upper)

    alice = store.create_principal(email="Alice@x.io", name="Alice")
    assert alice.id is not None
    # Normalizer upper-cases entity codes on write, so a lowercase grant is stored effectively.
    store.replace_grants(alice.id, ENTITY, {"fr10": False})
    # A team grant the user inherits through membership.
    team = store.create_team(name="Finance")
    assert team.id is not None
    store.replace_team_grants(team.id, ENTITY, {"us10": True})
    store.replace_team_members(team.id, [alice.id])

    with Session(engine) as s:
        access = resolve_access(s, "alice@x.io")  # case-insensitive lookup
    assert access is not None and access.is_admin is False
    assert access.read[ENTITY] == frozenset({"FR10", "US10"})  # direct + team, union
    assert access.write[ENTITY] == frozenset(
        {"US10"}
    )  # only the team grant was writable


def test_resolve_unknown_is_none_and_admin_flag() -> None:
    engine = _engine()
    store = RbacStore(engine)
    with Session(engine) as s:
        assert resolve_access(s, "nobody@x.io") is None
    admin = store.create_principal(email="root@x.io", name="", is_admin=True)
    assert admin.id is not None
    with Session(engine) as s:
        access = resolve_access(s, "root@x.io")
    assert access is not None and access.is_admin is True


def test_pg_policy_uses_injected_permissions_subclass() -> None:
    @dataclass(frozen=True)
    class AppPermissions(Permissions):
        refinements: frozenset[str] = frozenset({COST_CENTER})
        mandatory: str | None = ENTITY

    engine = _engine()
    store = RbacStore(engine)
    p = store.create_principal(email="u@x.io", name="U")
    assert p.id is not None
    store.replace_grants(p.id, ENTITY, {"FR10": False})
    policy = PgAccessPolicy(engine, permissions=AppPermissions)

    perms = policy.scope_for(_Caller("u@x.io"))
    assert isinstance(perms, AppPermissions)
    assert (
        perms.has_mandatory_access() is True
    )  # holds an entity grant (the mandatory dim)
    assert (
        perms.allowed_read(COST_CENTER) is None
    )  # refinement, ungranted -> unrestricted
    # An unknown caller resolves to a denied AppPermissions (policy still carries the app config).
    denied = policy.scope_for(_Caller("ghost@x.io"))
    assert isinstance(denied, AppPermissions) and denied.has_mandatory_access() is False


def test_allow_all_policy_is_admin_bypass() -> None:
    perms = AllowAllAccessPolicy().scope_for(_Caller("dev@x.io"))
    assert perms.is_admin is True and perms.unrestricted is True


def test_duplicate_principal_and_team_are_rejected() -> None:
    engine = _engine()
    store = RbacStore(engine)
    store.create_principal(email="dup@x.io", name="A")
    with pytest.raises(DuplicatePrincipalError):
        store.create_principal(email="DUP@x.io", name="B")  # case-insensitive clash
    store.create_team(name="Team")
    with pytest.raises(DuplicateTeamError):
        store.create_team(name="Team")


def test_new_user_joins_no_team() -> None:
    engine = _engine()
    store = RbacStore(engine)
    # A team existing must never auto-enrol anyone: membership is always explicit.
    store.create_team(name="Everyone")
    user = store.create_principal(email="new@x.io", name="N")
    assert user.id is not None
    assert store.team_ids_for(user.id) == []


def test_delete_team_removes_it() -> None:
    engine = _engine()
    store = RbacStore(engine)
    team = store.create_team(name="Ops")
    assert team.id is not None
    assert store.delete_team(team.id) is True
    assert store.get_team(team.id) is None
    assert store.delete_team(team.id) is False  # already gone


def test_principal_email_is_case_folded_on_write() -> None:
    engine = _engine()
    store = RbacStore(engine)
    p = store.create_principal(email="Mixed@X.IO", name="M")
    # Folded on write so the plain unique(email) index enforces case-insensitive uniqueness.
    assert p.email == "mixed@x.io"


def test_team_name_preserves_display_case_and_rejects_case_variants() -> None:
    engine = _engine()
    store = RbacStore(engine)
    finance = store.create_team(name="  Finance  ")
    # The display label is preserved (trimmed, original casing); uniqueness is case-insensitive.
    assert finance.name == "Finance"
    with pytest.raises(DuplicateTeamError):
        store.create_team(name="FINANCE")  # case-insensitive clash
    # Rename preserves the new display casing and rejects a clash against another team's folded name.
    ops = store.create_team(name="Ops")
    assert ops.id is not None
    renamed = store.rename_team(ops.id, "  Legal Ops  ")
    assert renamed is not None and renamed.name == "Legal Ops"
    with pytest.raises(DuplicateTeamError):
        store.rename_team(ops.id, "finance")  # would collide with the Finance team


def test_paged_matrix_reads_are_bounded_to_the_page() -> None:
    # The admin matrix pages the tenant instead of loading it whole; the grouped grant/membership
    # reads are constrained to the page's ids. Same SQLModel selects the async endpoint runs.
    engine = _engine()
    store = RbacStore(engine)
    ids = {}
    for email in ("carol@x.io", "alice@x.io", "bob@x.io", "dave@x.io"):  # inserted out of order
        principal = store.create_principal(email=email, name=email.split("@")[0])
        assert principal.id is not None
        ids[email] = principal.id
    store.replace_grants(ids["alice@x.io"], ENTITY, {"fr10": False})
    team = store.create_team(name="Finance")
    assert team.id is not None
    store.replace_team_members(team.id, [ids["bob@x.io"]])

    assert store.count_principals() == 4
    first = store.page_principals(needle="", limit=2, offset=0)
    assert [p.email for p in first] == ["alice@x.io", "bob@x.io"]  # email order, page 1
    second = store.page_principals(needle="", limit=2, offset=2)
    assert [p.email for p in second] == ["carol@x.io", "dave@x.io"]  # page 2

    assert store.count_principals("ali") == 1  # search bounds the count too
    assert [p.email for p in store.page_principals(needle="ali", limit=50, offset=0)] == ["alice@x.io"]

    page_ids = [p.id for p in first]
    grants = store.grants_by_principals(page_ids)
    assert set(grants) <= set(page_ids)
    assert grants[ids["alice@x.io"]][0].value == "fr10"
    assert store.team_ids_by_principals(page_ids)[ids["bob@x.io"]] == [team.id]
    # A page that excludes alice never loads alice's grants.
    assert ids["alice@x.io"] not in store.grants_by_principals([ids["carol@x.io"], ids["dave@x.io"]])
    assert store.grants_by_principals([]) == {} and store.team_ids_by_principals([]) == {}


def test_paged_team_reads_are_bounded_to_the_page() -> None:
    # The team matrix pages teams instead of loading every team's grants and membership at once; the
    # grouped reads are constrained to the page's ids, so one "Everyone" team can't dump the tenant.
    engine = _engine()
    store = RbacStore(engine)
    member = store.create_principal(email="m@x.io", name="m")
    assert member.id is not None
    team_ids = {}
    for name in ("Sales", "Alpha", "Ops", "Zeta"):  # inserted out of name order
        team = store.create_team(name=name)
        assert team.id is not None
        team_ids[name] = team.id
    store.replace_team_grants(team_ids["Alpha"], ENTITY, {"fr10": False})
    store.replace_team_members(team_ids["Sales"], [member.id])

    # Team names keep their display casing; search + uniqueness are case-insensitive.
    assert store.count_teams() == 4
    first = store.page_teams(needle="", limit=2, offset=0)
    assert [t.name for t in first] == ["Alpha", "Ops"]  # name order, page 1
    assert [t.name for t in store.page_teams(needle="", limit=2, offset=2)] == ["Sales", "Zeta"]

    assert store.count_teams("alph") == 1  # case-insensitive name search bounds the count too
    assert [t.name for t in store.page_teams(needle="alph", limit=50, offset=0)] == ["Alpha"]

    page_ids = [t.id for t in first]
    grants = store.team_grants_by_team(page_ids)
    assert set(grants) <= set(page_ids)
    assert grants[team_ids["Alpha"]][0].value == "fr10"
    # A page that excludes Sales never loads Sales' membership.
    assert team_ids["Sales"] not in store.member_ids_by_team([team_ids["Alpha"], team_ids["Ops"]])
    assert store.member_ids_by_team([team_ids["Sales"]])[team_ids["Sales"]] == [member.id]
    assert store.team_grants_by_team([]) == {} and store.member_ids_by_team([]) == {}


def test_team_membership_is_counted_paged_and_edited_incrementally() -> None:
    # The team list carries a member COUNT (not every id), membership pages/searches, and edits are
    # incremental (add/remove one) - so a large "Everyone" team is never serialized in one request.
    engine = _engine()
    store = RbacStore(engine)
    team = store.create_team(name="Everyone")
    assert team.id is not None
    people = {
        email: store.create_principal(email=email, name=email.split("@")[0])
        for email in ("carol@x.io", "alice@x.io", "bob@x.io")  # inserted out of email order
    }

    for p in people.values():
        assert p.id is not None
        assert store.add_team_member(team.id, p.id) is True
    assert store.add_team_member(team.id, people["alice@x.io"].id) is True  # idempotent, no duplicate

    # The list carries a count, bounded to the page's teams.
    assert store.member_counts_by_team([team.id]) == {team.id: 3}
    assert store.member_counts_by_team([]) == {}

    # Membership pages in email order and the search bounds both the page and its total.
    assert store.count_team_members(team.id) == 3
    assert [p.email for p in store.page_team_members(team.id, needle="", limit=2, offset=0)] == [
        "alice@x.io",
        "bob@x.io",
    ]
    assert [p.email for p in store.page_team_members(team.id, needle="", limit=2, offset=2)] == [
        "carol@x.io",
    ]
    assert store.count_team_members(team.id, "ali") == 1
    assert [p.email for p in store.page_team_members(team.id, needle="ali", limit=50, offset=0)] == [
        "alice@x.io",
    ]

    # Incremental remove, idempotent, and unknown ids are typed failures not silent orphans.
    assert store.remove_team_member(team.id, people["bob@x.io"].id) is True
    assert store.remove_team_member(team.id, people["bob@x.io"].id) is True  # idempotent
    assert store.count_team_members(team.id) == 2
    assert store.add_team_member(9999, people["alice@x.io"].id) is False  # unknown team
    assert store.add_team_member(team.id, 9999) is False  # unknown principal
    assert store.remove_team_member(9999, people["alice@x.io"].id) is False  # unknown team


def test_replace_grants_is_a_deterministic_whole_section_overwrite() -> None:
    # Guards the locked delete-then-insert: replacing a section overwrites it wholesale, so a
    # re-save is deterministic (not additive, no leftover of the previous set).
    engine = _engine()
    store = RbacStore(engine)
    user = store.create_principal(email="u@x.io", name="U")
    assert user.id is not None
    store.replace_grants(user.id, ENTITY, {"fr10": False, "us10": True})
    store.replace_grants(user.id, ENTITY, {"fr10": True})  # us10 dropped, fr10 write flipped
    entity_grants = sorted(
        (g.value, g.write) for g in store.list_grants(user.id) if g.dimension == ENTITY
    )
    assert entity_grants == [("fr10", True)]


def test_bootstrap_creates_and_restores_admins() -> None:
    engine = _engine()
    store = RbacStore(engine)
    ensure_bootstrap(store, ["boss@x.io", "BOSS@x.io", ""])  # dup + blank tolerated
    admins = [p for p in store.list_principals() if p.is_admin]
    assert [p.email for p in admins] == ["boss@x.io"]
    # Demote (another admin exists, so this is not the last one) then re-bootstrap restores admin.
    store.create_principal(email="other@x.io", name="", is_admin=True)
    assert admins[0].id is not None
    store.set_admin(admins[0].id, False)
    ensure_bootstrap(store, ["boss@x.io"])
    assert store.get_principal(admins[0].id).is_admin is True  # type: ignore[union-attr]
