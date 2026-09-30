"""The caller identity, as asserted by the gateway.

Built from the user-id and user-email headers the gateway injects after it authenticates the caller
against Keycloak. The app verifies nothing: these headers are the trust boundary. They are
trustworthy only because the gateway strips any client-supplied copy and the API is unreachable
except through it. See deploy/docker/gateway/apisix.yaml.

The header *names* are configurable so the app can sit behind a gateway that uses a different
convention — e.g. a platform that injects ``user-uid``/``user-email`` instead of the default
``x-user-id``/``x-user-email``. They come from the typed ``env.identity`` settings (which loads the
repo-root ``.env`` via ``BaseEnv``, so the values are resolved regardless of import order), and are
lower-cased here since HTTP header names are case-insensitive.
"""

from collections.abc import Mapping
from dataclasses import dataclass

from env.identity import env as _identity_env

HEADER_USER_ID = _identity_env.identity_header_user_id.strip().lower()
HEADER_USER_EMAIL = _identity_env.identity_header_user_email.strip().lower()


@dataclass(frozen=True)
class Identity:
    user_id: str
    email: str | None = None


def parse_identity(headers: Mapping[str, str]) -> Identity | None:
    """The caller named by the gateway, or None if it named nobody."""
    user_id = (headers.get(HEADER_USER_ID) or "").strip()
    if not user_id:
        return None

    email = (headers.get(HEADER_USER_EMAIL) or "").strip()
    return Identity(user_id=user_id, email=email or None)
