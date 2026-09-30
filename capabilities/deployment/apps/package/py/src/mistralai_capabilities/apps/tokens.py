"""The caller token the gateway puts on each request, and where the request being served keeps it.

No web framework here, so a non-HTTP caller can read the token the same way a route does.
"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar

__all__ = ["TOKEN_HEADERS", "bound_token", "current_token", "token_from"]

# The names the gateway sends the caller token under. They carry the same value.
TOKEN_HEADERS = ("x-apps-token", "x-space-token")

_token: ContextVar[str | None] = ContextVar("apps_gateway_token", default=None)


def token_from(headers: Mapping[str, str]) -> str | None:
    """The caller token in ``headers``, or None if the request brought none."""
    for name in TOKEN_HEADERS:
        token = headers.get(name)
        if token:
            return token
    return None


@contextmanager
def bound_token(token: str | None) -> Iterator[None]:
    """Hold ``token`` for the body, then put back whatever was there before.

    The restore matters where the task outlives the request: an in-process ASGI transport, or a
    test driving the app directly. Anything running in that task afterwards would otherwise still
    read the caller's credential and spend it on work the caller never asked for.
    """
    reset = _token.set(token)
    try:
        yield
    finally:
        _token.reset(reset)


def current_token() -> str | None:
    """The caller token on the request being served, or None outside one."""
    return _token.get()
