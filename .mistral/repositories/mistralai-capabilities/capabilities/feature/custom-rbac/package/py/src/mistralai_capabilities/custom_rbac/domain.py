"""Authorization value objects and pure rules: the permissions and how they narrow.

All pure (no IO, no framework, no ORM). ``Permissions`` is the per-caller boundary:
which values of each dimension the caller may read and write, plus whether they are
an admin (full bypass). Every data query narrows through ``scoped_codes`` on the
readable set, so tightening a caller's access is data the policy returns, not new
call-site code.

The dimension vocabulary is the CALLER's, not this capability's: ``Permissions``
carries the app's dimension policy (``refinements`` and an optional ``mandatory``
gate) as data, so one rule set serves a pages-only app and a multi-dimension one
with no domain assumptions baked in. ``PAGE`` is the one universal pseudo-dimension
(it gates a page/feature); every other dimension is app-supplied.

Admission - whether a caller may enter the app at all - is deliberately NOT here.
In this stack the gateway authenticates the caller and the ``api`` capability's
``require_user`` enforces that an identity is present and active. ``access`` is
authorization only: what an already-admitted caller may see and do.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

#: The one universal pseudo-dimension: gates a whole page/feature. Every other
#: dimension is app-supplied (passed to ``Permissions`` as ``refinements`` and an
#: optional ``mandatory`` gate); the core hardcodes no domain dimensions.
PAGE = "page"

#: Reserved delimiter between a page and its tab in a namespaced ``PAGE`` value. A page id or tab id
#: may not contain it, which keeps ``tab_value`` injective: a plain page grant can never collide with
#: a ``page:tab`` grant, so a page value cannot silently pass a restricted-tab gate.
TAB_SEP = ":"


def tab_value(page: str, tab: str) -> str:
    """The namespaced ``PAGE`` value for a tab under a page, e.g. ``settings:members``. A tab is
    just a value of the ``PAGE`` dimension, so it reuses the grant store and every page check;
    which pages have tabs (and which are restricted) is app config, never baked in here.

    ``page`` and ``tab`` may not contain the reserved ``:`` delimiter; this is enforced here (the one
    chokepoint every tab check flows through) so the encoding stays unambiguous."""
    if TAB_SEP in page or TAB_SEP in tab:
        raise ValueError(
            f"page and tab ids may not contain the reserved {TAB_SEP!r} delimiter: page={page!r}, tab={tab!r}"
        )
    return f"{page}{TAB_SEP}{tab}"


def validate_page_id(page: str) -> str:
    """Return ``page`` unchanged, rejecting a raw ``PAGE`` id that contains the reserved ``:``
    delimiter. A page id like ``settings:billing`` is byte-identical to ``tab_value("settings",
    "billing")``, so without this a plain page grant would silently satisfy a restricted-tab gate.
    Catalog boundaries validate every page id through this so page and tab codes can never collide."""
    if TAB_SEP in page:
        raise ValueError(
            f"page id may not contain the reserved {TAB_SEP!r} delimiter (it collides with a tab code): {page!r}"
        )
    return page


@dataclass(frozen=True, slots=True)
class Permissions:
    """What a caller may read and write, per dimension.

    ``is_admin`` bypasses everything (full read/write + manage access).
    ``unrestricted`` is the dev / allow-all result (full read/write, not admin).
    Otherwise ``read`` and ``write`` map a dimension to the exact set of allowed
    values; ``write`` is always a subset of ``read`` (a write grant is a grant).

    The dimension policy is app config carried on the value object:

    - ``refinements`` are dimensions that only NARROW when granted and impose no
      restriction when ungranted (``allowed_read`` returns ``None`` = all). They
      never, on their own, open access.
    - ``mandatory`` is the optional primary gate: a non-admin with no grant on it
      sees nothing anywhere (``has_mandatory_access`` is False). ``None`` = no
      primary gate (a pages-only app), so access is open past the per-page checks.

    The defaults (no refinements, no mandatory gate) give the pages-only model.
    """

    is_admin: bool = False
    unrestricted: bool = False
    read: Mapping[str, frozenset[str]] = field(default_factory=dict)
    write: Mapping[str, frozenset[str]] = field(default_factory=dict)
    refinements: frozenset[str] = frozenset()
    mandatory: str | None = None

    @property
    def _sees_all(self) -> bool:
        return self.is_admin or self.unrestricted

    def allowed_read(self, dimension: str) -> frozenset[str] | None:
        """Readable values for a dimension, or ``None`` for unrestricted (all).

        Admin / allow-all reads everything (``None``). A refinement dimension the
        caller has no grant on is unrestricted (``None`` = all): refinements only
        narrow when granted, they never gate. Every other dimension (the mandatory
        gate, and ``PAGE``) with no grant is restricted to nothing (empty), i.e.
        deny by default. The primary gate lives in ``has_mandatory_access``: a
        caller who fails it sees nothing regardless of what a refinement returns."""
        if self._sees_all:
            return None
        grant = self.read.get(dimension, frozenset())
        if not grant and dimension in self.refinements:
            return None
        return grant

    def allowed_write(self, dimension: str) -> frozenset[str] | None:
        """Writable values for a dimension, or ``None`` for unrestricted (all).

        Writes stay deny-by-default on every dimension (no refinement widening): an
        ungranted dimension is the empty set, never ``None``. Write actions gate on
        ``can_write`` (exact membership), so this only ever narrows, never opens."""
        return None if self._sees_all else self.write.get(dimension, frozenset())

    def can_read(self, dimension: str, value: str) -> bool:
        """Whether one value is readable, agreeing with ``allowed_read``: an ungranted refinement
        dimension reads as all, so a per-value gate never denies what the query path would show."""
        allowed = self.allowed_read(dimension)
        return allowed is None or value in allowed

    def can_write(self, dimension: str, value: str) -> bool:
        return self._sees_all or value in self.write.get(dimension, frozenset())

    def can_read_tab(self, page: str, tab: str, *, restricted: bool) -> bool:
        """Whether the caller may see a tab under a page (a ``page:tab`` PAGE value). A whole-page
        read grant implies the page's non-restricted tabs; a ``restricted`` tab is never implied
        and needs its own ``page:tab`` grant. Admin / allow-all bypass.

        ``restricted`` is mandatory (keyword-only, no default): a tab's sensitivity is app config the
        caller must state explicitly, so a forgotten argument can never silently broaden a sensitive
        tab to every whole-page grantee (fail closed)."""
        value = tab_value(page, tab)
        if restricted:
            return self.can_read(PAGE, value)
        return self.can_read(PAGE, page) or self.can_read(PAGE, value)

    def can_write_tab(self, page: str, tab: str, *, restricted: bool) -> bool:
        """Write counterpart of ``can_read_tab``: a whole-page write grant implies the
        non-restricted tabs; a restricted tab needs its own ``page:tab`` write grant.
        Deny-by-default like every write; admin bypasses. ``restricted`` is mandatory, so a write
        gate can never fall open by omitting it."""
        value = tab_value(page, tab)
        if restricted:
            return self.can_write(PAGE, value)
        return self.can_write(PAGE, page) or self.can_write(PAGE, value)

    def has_mandatory_access(self) -> bool:
        """The mandatory gate: whether the caller may see any data at all - an admin /
        allow-all, a holder of at least one grant on the ``mandatory`` dimension, or
        any caller when no mandatory gate is configured. A caller who fails it sees
        nothing anywhere, regardless of any refinement grant: refinements narrow
        within the gated scope, they never open it."""
        if self._sees_all:
            return True
        if self.mandatory is None:
            return True
        return bool(self.read.get(self.mandatory))


#: Non-admin "sees everything" result (unused for admin, which sets ``is_admin``).
UNRESTRICTED = Permissions(unrestricted=True)


def scoped_codes(requested: tuple[str, ...], allowed: frozenset[str] | None) -> tuple[str, ...]:
    """Narrow a requested filter selection to what the caller is allowed to see.

    - ``allowed is None`` (unrestricted): the request passes through unchanged.
    - No explicit request: restrict to exactly the allowed set (the mandatory
      floor, so an unfiltered query still cannot exceed the caller's scope).
    - An explicit request: keep only the requested codes that are allowed (an
      intersection), so a caller can never widen past their scope by asking.
    """
    if allowed is None:
        return requested
    if not requested:
        return tuple(sorted(allowed))
    return tuple(code for code in requested if code in allowed)


def is_denied(allowed: frozenset[str] | None, effective: tuple[str, ...]) -> bool:
    """True when a caller is restricted on a dimension (``allowed`` is not None) but
    the effective selection is empty, i.e. they may see nothing.

    Query routers must short-circuit on this: an empty filter tuple otherwise reads
    as "no filter -> all rows" in the adapters, so a denied or fully out-of-scope
    request would leak everything. Unrestricted (``allowed is None``) is never denied.
    """
    return allowed is not None and not effective
