"""The app's half of edge authentication.

The app does not authenticate anyone. It reads ``x-user-id`` from the request and believes it.
These tests cover what it does with that assertion: resolve the user, refuse deactivated users, and
refuse requests with no assertion. The gateway makes the header unforgeable (see
deploy/docker/gateway/apisix.yaml); no test here can prove that.
"""

import sys
from pathlib import Path

import api.routers.api.v1 as v1
import pytest
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi_auth.identity import (
    HEADER_USER_EMAIL,
    HEADER_USER_ID,
    parse_identity,
    require_user,
)
from support.auth import FakeUserStore, auth_headers, auth_hooks

from conftest import build_app

_AUTHED_ROUTE = "/api/v1/auth_probe"


@pytest.fixture
def users() -> FakeUserStore:
    return FakeUserStore()


@pytest.fixture
def protected_client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    users: FakeUserStore,
) -> TestClient:
    """A tiny route tree whose `v1` package uses the same auth rule as the shipped tree.

    The API capability has no protected business route of its own; feature capabilities contribute
    those. This fixture contributes one test route under the real `api.routers.api.v1` package, so it
    stays capability-independent while still proving the shipped v1 package's rule is applied.
    """
    routes = tmp_path / "api_routers_v1_probe"
    routes.mkdir()
    (routes / "auth_probe.py").write_text(
        "from fastapi import APIRouter\n\n"
        "router = APIRouter()\n\n\n"
        "@router.get('', operation_id='protected_probe')\n"
        "async def protected_probe() -> dict[str, str]:\n"
        "    return {'status': 'ok'}\n"
    )
    for name in [name for name in sys.modules if name == "api.routers.api.v1.auth_probe"]:
        del sys.modules[name]
    monkeypatch.setattr(v1, "__path__", [str(routes)])
    return TestClient(build_app(hooks=auth_hooks(users), routers="api.routers.api.v1", prefix="/api/v1"))


def test_parse_identity_reads_the_gateway_headers() -> None:
    identity = parse_identity({"x-user-id": " abc ", "x-user-email": " a@b.test "})
    assert identity is not None
    assert identity.user_id == "abc"
    assert identity.email == "a@b.test"


def test_parse_identity_returns_none_without_a_user_id() -> None:
    assert parse_identity({}) is None
    assert parse_identity({"x-user-id": ""}) is None
    assert parse_identity({"x-user-id": "   "}) is None
    assert parse_identity({"x-user-email": "a@b.test"}) is None


def test_an_email_is_optional() -> None:
    identity = parse_identity({"x-user-id": "abc"})
    assert identity is not None
    assert identity.email is None


def test_public_routes_do_not_require_identity(client: TestClient) -> None:
    assert client.get("/api/health").status_code == 200


def test_the_gateway_identity_is_adopted(protected_client: TestClient, users: FakeUserStore) -> None:
    headers = auth_headers()
    res = protected_client.get(_AUTHED_ROUTE, headers=headers)

    # Not rejected, rather than a specific success code: what is being pinned is that the
    # identity was adopted and the store was consulted, and `200` vs `202` is the route's
    # business, not this suite's.
    assert res.status_code < 400
    assert users.seen == [(headers[HEADER_USER_ID], headers[HEADER_USER_EMAIL])]


def test_a_request_without_an_identity_is_rejected(
    protected_client: TestClient,
) -> None:
    res = protected_client.get(_AUTHED_ROUTE)

    assert res.status_code == 401
    assert res.json() == {"detail": "Missing gateway identity"}
    assert res.headers["WWW-Authenticate"].startswith("Bearer")


def test_a_blank_identity_header_is_not_an_identity(
    protected_client: TestClient,
) -> None:
    # A present-but-empty header must not read as "some user"; it means the gateway
    # named nobody, which is the same as sending nothing.
    res = protected_client.get(_AUTHED_ROUTE, headers={HEADER_USER_ID: "   "})

    assert res.status_code == 401


def test_a_bearer_token_alone_is_not_an_identity(protected_client: TestClient) -> None:
    # The app no longer looks at Authorization at all — the gateway consumes it and
    # strips it. A caller presenting only a token has not been through the gateway.
    res = protected_client.get(
        _AUTHED_ROUTE,
        headers={"Authorization": "Bearer whatever"},
    )

    assert res.status_code == 401


def test_an_inactive_user_is_forbidden(protected_client: TestClient, users: FakeUserStore) -> None:
    users.is_active = False

    res = protected_client.get(_AUTHED_ROUTE, headers=auth_headers())

    assert res.status_code == 403
    assert res.json() == {"detail": "User is not active"}


def test_the_schema_and_docs_are_anonymous(client: TestClient) -> None:
    """The deliberate cost of gating at the router instead of the app.

    ``require_user`` is a route dependency, so it reaches only what the host mounts it on. These
    three belong to no router and are open. The gateway forwards only ``/api/*``, so reaching them
    means already being inside the network.
    """
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200


def test_protected_routes_declare_the_bearer_scheme(
    protected_client: TestClient,
) -> None:
    """The contract must say a route needs a token, or the generated client will not send one."""
    spec = protected_client.app.openapi()
    schemes = spec.get("components", {}).get("securitySchemes", {})
    assert "HTTPBearer" in schemes, "no bearer security scheme reached the OpenAPI document"
    assert schemes["HTTPBearer"]["bearerFormat"] == "JWT"

    operation = spec["paths"][_AUTHED_ROUTE]["get"]
    assert operation.get("security"), f"GET {_AUTHED_ROUTE} does not declare its bearer requirement"


def test_every_protected_route_refuses_an_anonymous_caller(
    protected_client: TestClient,
) -> None:
    """Ties the real v1 grouping to behaviour: it must 401 without a caller."""
    response = protected_client.get(_AUTHED_ROUTE)

    assert response.status_code == 401


def test_v1_declares_the_authentication_gate() -> None:
    assert [dependency.dependency for dependency in v1.dependencies] == [require_user]
