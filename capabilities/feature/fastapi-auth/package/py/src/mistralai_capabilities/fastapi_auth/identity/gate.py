"""The gate, and route-level access to the resolved caller.

This is a FastAPI dependency, not ASGI middleware. It protects only the routers it is mounted on.
Paths outside the authenticated router tree (``/openapi.json``, ``/docs``, and ``/redoc``) are not covered.
"""

from typing import Annotated

from fastapi import Depends, HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from env.app import env as app_env

from mistralai_capabilities.fastapi_auth.identity.headers import parse_identity
from mistralai_capabilities.fastapi_auth.identity.store import Users
from mistralai_capabilities.fastapi_auth.identity.user import User

# MCP clients need this to discover that they must authenticate; without it they fail
# opaquely instead of starting an OAuth flow.
_CHALLENGE = {"WWW-Authenticate": f'Bearer realm="{app_env.app_name}"'}

# `auto_error=False`: this dependency is the enforcement point and raises its own 401. The
# scheme exists so the bearer requirement reaches the OpenAPI document — and from there
# `/docs` and the generated web client, which would otherwise describe every protected
# route as public.
_bearer = HTTPBearer(bearerFormat="JWT", auto_error=False)

BearerToken = Annotated[HTTPAuthorizationCredentials | None, Security(_bearer)]


async def require_user(request: Request, users: Users, _credentials: BearerToken = None) -> User:
    """Resolve the caller the gateway asserted, or refuse the request.

    This app authenticates nobody. The gateway validated the caller against Keycloak and sends its
    assertion. This helper enforces what the gateway cannot know: that an assertion exists, and that
    the local user row is active. The store arrives as a dependency, so a test can swap it with
    ``dependency_overrides``.
    """
    identity = parse_identity(request.headers)
    if identity is None:
        # Through the gateway this cannot happen — it 401s first — so in practice this
        # fires only when something reached the API without traversing it, which is
        # exactly when refusing matters.
        raise HTTPException(status_code=401, detail="Missing gateway identity", headers=_CHALLENGE)

    user = await users.upsert(user_id=identity.user_id, email=identity.email)
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is not active")
    return user


# One dependency, declared twice: the host applies it at the mount, so a router is gated by
# the act of being mounted, and a route names it again to receive the user. FastAPI caches
# by callable, so the upsert still runs once per request.
CurrentUser = Annotated[User, Depends(require_user)]
