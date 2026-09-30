"""Reading the caller token off a request, and keeping it where the code serving that request looks.

The gateway sends the same token under two names, so both must be read and the pair must agree.
"""

import asyncio

import pytest
from mistralai_capabilities.apps.middleware import GatewayTokenMiddleware
from mistralai_capabilities.apps.tokens import bound_token, current_token, token_from


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        pytest.param({"x-apps-token": "tok-apps"}, "tok-apps", id="apps"),
        pytest.param({"x-space-token": "tok-space"}, "tok-space", id="space"),
        pytest.param({"x-apps-token": "tok-apps", "x-space-token": "tok-space"}, "tok-apps", id="apps_first"),
    ],
)
def test_the_token_is_read_under_either_name(headers: dict[str, str], expected: str) -> None:
    assert token_from(headers) == expected


@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({}, id="no_headers"),
        pytest.param({"authorization": "Bearer tok"}, id="some_other_header"),
        pytest.param({"x-apps-token": ""}, id="empty_value"),
    ],
)
def test_a_request_without_the_token_reads_as_none(headers: dict[str, str]) -> None:
    assert token_from(headers) is None


def test_outside_a_request_there_is_no_token() -> None:
    assert current_token() is None


def _call(middleware: GatewayTokenMiddleware, scope: dict[str, object]) -> None:
    async def receive() -> dict[str, str]:
        return {"type": "http.request"}

    async def send(message: dict[str, object]) -> None:
        return None

    asyncio.run(middleware(scope, receive, send))


@pytest.mark.parametrize("scope_type", ["http", "websocket"])
def test_the_middleware_hands_the_token_to_the_code_it_wraps(scope_type: str) -> None:
    seen: list[str | None] = []

    async def app(scope: dict[str, object], receive: object, send: object) -> None:
        seen.append(current_token())

    _call(
        GatewayTokenMiddleware(app),
        {"type": scope_type, "headers": [(b"x-apps-token", b"tok-caller")]},
    )
    assert seen == ["tok-caller"]


def test_the_token_is_gone_once_the_request_is_served() -> None:
    """Whatever shares the task after the response must not still be holding the caller's token."""
    seen: list[str | None] = []

    async def app(scope: dict[str, object], receive: object, send: object) -> None:
        seen.append(current_token())

    async def receive() -> dict[str, str]:
        return {"type": "http.request"}

    async def send(message: dict[str, object]) -> None:
        return None

    async def serve_then_look() -> None:
        middleware = GatewayTokenMiddleware(app)
        await middleware({"type": "http", "headers": [(b"x-apps-token", b"tok-caller")]}, receive, send)
        seen.append(current_token())

    asyncio.run(serve_then_look())
    assert seen == ["tok-caller", None]


def test_a_lifespan_message_is_passed_through_untouched() -> None:
    # Nothing to read a token off, and setting one there would leak into whatever runs next.
    reached = False

    async def app(scope: dict[str, object], receive: object, send: object) -> None:
        nonlocal reached
        reached = True

    with bound_token("tok-earlier"):
        _call(GatewayTokenMiddleware(app), {"type": "lifespan"})
        assert current_token() == "tok-earlier"
    assert reached is True
