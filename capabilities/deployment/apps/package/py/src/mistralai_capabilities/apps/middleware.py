"""ASGI middleware that hands each request's caller token to the code serving it."""

from mistralai_capabilities.apps.tokens import bound_token, token_from
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

__all__ = ["GatewayTokenMiddleware"]


class GatewayTokenMiddleware:
    """Read the caller token off the wire and put it where ``utils.mistral`` will look.

    Plain ASGI rather than ``BaseHTTPMiddleware``, so the token is set in the same task that runs
    the route, and it is unset again before that task goes on to anything else.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        with bound_token(token_from(Headers(scope=scope))):
            await self.app(scope, receive, send)
