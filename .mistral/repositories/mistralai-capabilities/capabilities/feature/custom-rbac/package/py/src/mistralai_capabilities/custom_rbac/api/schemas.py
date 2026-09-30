"""Typed request/response models for the access admin API.

Generic over dimensions: the catalog is a map keyed by the app's dimension names, so no
domain dimension is baked into the contract. Every route returns one of these, never a
raw dict.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


def _required(value: str, *, field: str, minimum: int) -> str:
    """Strip a user-supplied identifier and enforce a post-strip minimum length, so the value
    Pydantic accepts is the value the store persists (no all-whitespace email or team name)."""
    stripped = value.strip()
    if len(stripped) < minimum:
        raise ValueError(f"{field} must be at least {minimum} character(s) after trimming")
    return stripped


def _email(value: str) -> str:
    """Strip and validate an email's shape (local@domain.tld) at the API boundary, so an admin
    cannot create a principal like `abc` that can never match the gateway's email identity. Full
    RFC validation is the IdP's job; this only rejects an obvious non-email."""
    stripped = _required(value, field="email", minimum=3)
    local, at, domain = stripped.partition("@")
    if not at or not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ValueError("email must be a valid address (local@domain)")
    return stripped


class GrantOut(BaseModel):
    dimension: str
    value: str
    write: bool


class GrantEntry(BaseModel):
    value: str = Field(min_length=1)
    write: bool = False

    @field_validator("value")
    @classmethod
    def _clean_value(cls, value: str) -> str:
        return _required(value, field="value", minimum=1)


class GrantsReplace(BaseModel):
    entries: list[GrantEntry] = Field(default_factory=list)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    is_admin: bool
    grants: list[GrantOut]
    # The teams the user belongs to (their permissions are the union of these teams'
    # grants plus any legacy per-user grants above).
    team_ids: list[int] = Field(default_factory=list)
    # A bootstrap admin: cannot be demoted or deleted (UI locks these controls).
    protected: bool = False


class UsersPage(BaseModel):
    """One page of the admin matrix: the page's users plus the total matching the query, so the
    panel can render page controls without the endpoint ever loading the whole tenant."""

    items: list[UserOut]
    total: int
    limit: int
    offset: int


class UserCreate(BaseModel):
    email: str = Field(min_length=3)
    name: str = ""

    @field_validator("email")
    @classmethod
    def _clean_email(cls, value: str) -> str:
        return _email(value)


class AdminFlag(BaseModel):
    is_admin: bool


class SchemaOut(BaseModel):
    """The matrix columns: the pages (values of the PAGE dimension) and the data
    dimensions. The frontend pairs this with the catalog to render the checkboxes.

    ``tabs`` maps a page to its tab values (``page:tab`` codes) so the matrix nests tabs under
    their page with a select-all that cascades; a page absent here (or the whole map empty for an
    app without tabs) renders flat. Tabs are PAGE values, so their labels come from the catalog."""

    pages: list[str]
    dimensions: list[str]
    tabs: dict[str, list[str]] = Field(default_factory=dict)


class CatalogItemOut(BaseModel):
    value: str
    label: str


class CatalogOut(BaseModel):
    """The grantable values per dimension, keyed by dimension name (``page`` included), so
    the matrix renders one row per value with the exact codes enforcement checks."""

    catalog: dict[str, list[CatalogItemOut]]


class TeamSummary(BaseModel):
    """A team in the matrix: its grants plus a member COUNT rather than every member id, so listing a
    team (or an "Everyone" team) never serializes one id per tenant user. Membership is read and edited
    through the paged ``/teams/{id}/members`` endpoints."""

    id: int
    name: str
    member_count: int
    grants: list[GrantOut]


class TeamsPage(BaseModel):
    """One page of the team matrix: the page's teams (grants + member count) plus the total matching the
    query, so the panel renders page controls without the endpoint ever serializing every team's
    membership at once."""

    items: list[TeamSummary]
    total: int
    limit: int
    offset: int


class MemberOut(BaseModel):
    id: int
    email: str
    name: str


class TeamMembersPage(BaseModel):
    """One page of a team's membership plus the total matching the query, so an admin manages a large
    team's members without the endpoint ever loading the whole membership at once."""

    items: list[MemberOut]
    total: int
    limit: int
    offset: int


class TeamName(BaseModel):
    name: str = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        return _required(value, field="name", minimum=1)


class MembersReplace(BaseModel):
    principal_ids: list[int] = Field(default_factory=list)


class MeOut(BaseModel):
    """The caller's own authorization, for the frontend to gate nav + write actions.

    ``read``/``write`` map each dimension to the granted values; an admin or allow-all
    caller relies on ``is_admin``/``unrestricted`` instead. ``acting_as`` is set when an
    admin is previewing another user via the act-as header."""

    email: str
    is_admin: bool
    unrestricted: bool
    acting_as: str | None = None
    read: dict[str, list[str]] = Field(default_factory=dict)
    write: dict[str, list[str]] = Field(default_factory=dict)
