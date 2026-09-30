"""Header names the gateway uses to assert the caller.

Shipped by `fastapi-auth`, not `core`: these settings describe how the FastAPI identity gate reads
the caller the gateway injected, and nothing outside the authenticated API surface reads them.
Configurable for a gateway that follows a different convention (e.g. user-uid/user-email); defaults
match APISIX.
"""

from env._base import BaseEnv


class Env(BaseEnv):
    identity_header_user_id: str = "x-user-id"
    identity_header_user_email: str = "x-user-email"


env = Env()
