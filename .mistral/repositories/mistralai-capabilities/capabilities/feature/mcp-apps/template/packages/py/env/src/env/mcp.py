from typing import Literal, Self

from pydantic import AliasChoices, Field, model_validator

from env._base import BaseEnv
from env.api import env as http_env
from env.app import env as app_env


class Env(BaseEnv):
    mcp_server_url: str | None = None
    # The deployed app's public origin, injected by the platform. Without an explicit
    # MCP_SERVER_URL, the self-connector points at this origin's /mcp.
    public_origin: str | None = Field(
        default=None,
        validation_alias=AliasChoices("__APPS_PUBLIC_ORIGIN", "__SPACES_PUBLIC_ORIGIN"),
    )
    mcp_app_ui_url: str = http_env.cors_origin
    mcp_connector_name: str = app_env.app_name
    # Scope used when auto-registering the self connector. API keys can create the
    # `shared_*` scopes (not `private`, which needs a personal_and_shared key scope).
    mcp_connector_visibility: Literal["shared_workspace", "shared_org", "shared_global", "private"] = "shared_workspace"
    # Explicit opt-in for MCP-app surfacing: it needs a registered, publicly reachable
    # self-connector (a public ``mcp_server_url``, such as a tunnel). Off in local dev and every
    # internal deployment, so the agent still answers chat connector-free. ``bunx nx run agents:dev`` sets it.
    mcp_apps_enabled: bool = False

    @model_validator(mode="after")
    def _server_url_from_public_origin(self) -> Self:
        if self.mcp_server_url is None and self.public_origin is not None:
            self.mcp_server_url = f"{self.public_origin.rstrip('/')}/mcp"
        return self


env = Env()
