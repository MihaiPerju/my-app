"""Request-boundary validation: identifiers are stripped and rejected when blank, so the value
Pydantic accepts is the value the store persists (no all-whitespace email or team name)."""

from __future__ import annotations

import pytest
from mistralai_capabilities.custom_rbac.api.schemas import (
    GrantEntry,
    SchemaOut,
    TeamName,
    TeamsPage,
    TeamSummary,
    UserCreate,
    UserOut,
    UsersPage,
)
from pydantic import ValidationError


def test_user_create_strips_email() -> None:
    assert UserCreate(email="  a@x.io  ").email == "a@x.io"


def test_user_create_rejects_blank_email() -> None:
    with pytest.raises(ValidationError):
        UserCreate(email="   ")


def test_user_create_rejects_non_email() -> None:
    # A three-char string that is not an email (no local@domain.tld) must be rejected, so a
    # principal can never be created that the gateway's email identity can't match.
    for bad in ("abc", "a@b", "a@b.", "@x.io", "ab.io"):
        with pytest.raises(ValidationError):
            UserCreate(email=bad)


def test_team_name_strips_and_rejects_blank() -> None:
    assert TeamName(name="  Finance ").name == "Finance"
    with pytest.raises(ValidationError):
        TeamName(name=" ")


def test_grant_entry_rejects_blank_value() -> None:
    assert GrantEntry(value="  home ").value == "home"
    with pytest.raises(ValidationError):
        GrantEntry(value=" ")


def test_schema_out_tabs_default_empty() -> None:
    # A pages-only app (and any older backend) omits tabs; the field defaults to an empty map so
    # the matrix renders every page flat.
    schema = SchemaOut(pages=["home", "reports"], dimensions=[])
    assert schema.tabs == {}


def test_schema_out_carries_tabs() -> None:
    schema = SchemaOut(
        pages=["settings"],
        dimensions=[],
        tabs={"settings": ["settings:members", "settings:billing"]},
    )
    assert schema.tabs == {"settings": ["settings:members", "settings:billing"]}


def test_users_page_carries_page_metadata() -> None:
    # The admin matrix page envelope: the page's users plus the total/limit/offset the panel needs
    # to render page controls without ever loading the whole tenant.
    user = UserOut(id=1, email="a@x.io", name="A", is_admin=False, grants=[])
    page = UsersPage(items=[user], total=42, limit=50, offset=0)
    assert [u.email for u in page.items] == ["a@x.io"]
    assert (page.total, page.limit, page.offset) == (42, 50, 0)


def test_teams_page_carries_page_metadata() -> None:
    # The team matrix page envelope: the page's teams plus the total/limit/offset the panel needs to
    # render page controls, so one "Everyone" team can never serialize the whole tenant in a request.
    team = TeamSummary(id=1, name="Finance", member_count=1, grants=[])
    page = TeamsPage(items=[team], total=9, limit=50, offset=0)
    assert [t.name for t in page.items] == ["Finance"]
    assert (page.total, page.limit, page.offset) == (9, 50, 0)
