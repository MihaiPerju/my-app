"""Characterization tests for the pure authorization domain.

These freeze the byte-identical rules ported from the reference apps: admin bypass, the mandatory
gate, refinement dimensions (narrow-when-granted, unrestricted-when-not), the pages-only model,
``scoped_codes``, ``is_denied``, and write deny-by-default. Pure and dependency-free.
"""

import pytest
from mistralai_capabilities.custom_rbac.domain import (
    PAGE,
    Permissions,
    is_denied,
    scoped_codes,
    tab_value,
    validate_page_id,
)


def test_admin_sees_everything() -> None:
    admin = Permissions(is_admin=True, refinements=frozenset({"cc"}), mandatory="entity")
    assert admin.allowed_read("entity") is None
    assert admin.can_write("entity", "X")
    assert admin.has_mandatory_access()


def test_mandatory_gate_denies_without_grant() -> None:
    perms = Permissions(
        read={"cc": frozenset({"BUS1"})},
        refinements=frozenset({"cc"}),
        mandatory="entity",
    )
    assert perms.has_mandatory_access() is False
    assert perms.allowed_read("entity") == frozenset()  # deny-by-default on the gate dimension
    assert perms.allowed_read("cc") == frozenset({"BUS1"})  # granted refinement narrows


def test_refinement_ungranted_is_unrestricted() -> None:
    perms = Permissions(
        read={"entity": frozenset({"FR10"})},
        refinements=frozenset({"cc"}),
        mandatory="entity",
    )
    assert perms.has_mandatory_access() is True
    assert perms.allowed_read("cc") is None  # ungranted refinement => all
    assert perms.allowed_read("entity") == frozenset({"FR10"})


def test_pages_only_model() -> None:
    perms = Permissions(read={PAGE: frozenset({"pnl"})})
    assert perms.has_mandatory_access() is True  # no mandatory gate configured
    assert perms.can_read(PAGE, "pnl")
    assert not perms.can_read(PAGE, "x")


def test_scoped_codes() -> None:
    assert scoped_codes(("a", "b"), None) == ("a", "b")  # unrestricted passthrough
    assert scoped_codes((), frozenset({"b", "a"})) == (
        "a",
        "b",
    )  # empty request => sorted floor
    assert scoped_codes(("a", "c"), frozenset({"a", "b"})) == ("a",)  # intersection


def test_is_denied() -> None:
    assert is_denied(None, ()) is False  # unrestricted is never denied
    assert is_denied(frozenset({"a"}), ()) is True  # restricted + empty => denied
    assert is_denied(frozenset({"a"}), ("a",)) is False


def test_write_deny_by_default_and_subset() -> None:
    perms = Permissions(
        read={"entity": frozenset({"A", "B"})},
        write={"entity": frozenset({"A"})},
        mandatory="entity",
    )
    assert perms.can_write("entity", "A")
    assert not perms.can_write("entity", "B")
    assert perms.allowed_write("entity") == frozenset({"A"})
    assert perms.allowed_write("cc") == frozenset()  # ungranted => write denied, never None


def test_tab_value_namespaces_the_page() -> None:
    assert tab_value("settings", "members") == "settings:members"


def test_tab_value_rejects_reserved_delimiter() -> None:
    # A ':' in a page or tab id would make the encoding ambiguous (a page value could impersonate a
    # restricted tab), so it is rejected at the one chokepoint every tab check flows through.
    with pytest.raises(ValueError):
        tab_value("settings:billing", "members")
    with pytest.raises(ValueError):
        tab_value("settings", "bill:ing")


def test_validate_page_id_rejects_a_tab_colliding_page() -> None:
    # A page id equal to a tab code would let a plain page grant satisfy a restricted-tab gate:
    # granting page "settings:billing" must not open the restricted tab tab_value("settings","billing").
    assert validate_page_id("settings") == "settings"
    assert tab_value("settings", "billing") == "settings:billing"
    with pytest.raises(ValueError):
        validate_page_id("settings:billing")


def test_restricted_is_mandatory_so_a_tab_gate_cannot_fall_open() -> None:
    # restricted is keyword-only with no default: omitting it is a TypeError, not a silent broadening
    # of a sensitive tab to every whole-page grantee.
    perms = Permissions(read={PAGE: frozenset({"settings"})})
    with pytest.raises(TypeError):
        perms.can_read_tab("settings", "billing")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        perms.can_write_tab("settings", "billing")  # type: ignore[call-arg]


def test_whole_page_grant_implies_non_restricted_tabs_only() -> None:
    # A page grant opens the everyday tabs, but never a restricted one (needs its own grant).
    perms = Permissions(
        read={PAGE: frozenset({"settings"})},
        write={PAGE: frozenset({"settings"})},
    )
    assert perms.can_read_tab("settings", "general", restricted=False) is True
    assert perms.can_write_tab("settings", "general", restricted=False) is True
    assert perms.can_read_tab("settings", "billing", restricted=True) is False
    assert perms.can_write_tab("settings", "billing", restricted=True) is False


def test_tab_grant_opens_only_that_tab() -> None:
    perms = Permissions(read={PAGE: frozenset({tab_value("settings", "billing")})})
    assert perms.can_read_tab("settings", "billing", restricted=True) is True
    assert perms.can_read_tab("settings", "members", restricted=True) is False  # sibling
    assert perms.can_read(PAGE, "settings") is False  # a tab grant is not a whole-page grant
    assert perms.can_write_tab("settings", "billing", restricted=True) is False  # read-only


def test_tab_write_grant_allows_write_for_that_tab_only() -> None:
    value = tab_value("settings", "billing")
    perms = Permissions(read={PAGE: frozenset({value})}, write={PAGE: frozenset({value})})
    assert perms.can_write_tab("settings", "billing", restricted=True) is True
    assert perms.can_write_tab("settings", "members", restricted=True) is False


def test_admin_sees_every_tab() -> None:
    admin = Permissions(is_admin=True)
    assert admin.can_read_tab("settings", "billing", restricted=True) is True
    assert admin.can_write_tab("settings", "billing", restricted=True) is True


def test_bare_permissions_grant_no_tab() -> None:
    assert Permissions().can_read_tab("settings", "general", restricted=False) is False
    assert Permissions().can_write_tab("settings", "general", restricted=False) is False


def test_can_read_agrees_with_allowed_read_on_an_ungranted_refinement() -> None:
    perms = Permissions(read={"entity": frozenset({"FR10"})}, refinements=frozenset({"cc"}), mandatory="entity")
    assert perms.allowed_read("cc") is None
    assert perms.can_read("cc", "ANY") is True
    granted = Permissions(read={"cc": frozenset({"BUS1"})}, refinements=frozenset({"cc"}))
    assert granted.can_read("cc", "BUS1") is True
    assert granted.can_read("cc", "OPS2") is False
    assert Permissions().can_read("page", "home") is False
