"""The caller the gateway asserted, and the gate that insists there was one.

``require_user`` is a FastAPI dependency, not ASGI middleware, so it guards only the routers it is
mounted on. ``gate.py`` explains what that leaves uncovered and why the MCP surface is still guarded.
"""

from mistralai_capabilities.fastapi_auth.identity.gate import CurrentUser, require_user
from mistralai_capabilities.fastapi_auth.identity.headers import HEADER_USER_EMAIL, HEADER_USER_ID, parse_identity

__all__ = [
    "HEADER_USER_EMAIL",
    "HEADER_USER_ID",
    "CurrentUser",
    "parse_identity",
    "require_user",
]
