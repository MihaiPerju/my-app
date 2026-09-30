"""The MCP Apps runtime: this app's own MCP server, and the connector that reaches it.

Apps are module-level :class:`McpApp` values found by :mod:`~mistralai_capabilities.mcp_apps.
discovery`. This module mounts them as ``ui://`` resources and tools linked through
``_meta.ui.resourceUri`` (SEP-1865). It is the only module here that needs FastMCP. The agent-side half
-- the ``allow_mcp_ui`` connector -- lives in this capability's ``worker/agents/connectors/mcp_apps.py``
overlay, and the two halves agree through ``MCP_CONNECTOR_NAME``.
"""

import asyncio
import logging
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING

from env.app import env as app_env
from mistralai.client import Mistral
from mistralai_capabilities.mcp_apps.contract import McpApp

if TYPE_CHECKING:
    from fastmcp import FastMCP
    from fastmcp.server.http import StarletteWithLifespan

logger = logging.getLogger(__name__)


def create_mcp_app(*, ui_url: str, apps: Sequence[McpApp]) -> "StarletteWithLifespan":
    """Build this app's MCP server and return it as an ASGI app for the host to mount.

    The surface is the MCP Apps the host passes in. The HTTP API is not mirrored into tools,
    because that would be a second way to call a workflow, and the agent drives workflows directly.
    The result is a bare Starlette app with one route, so mounting it shadows no host route.
    FastMCP is imported here, not at module scope, so importing this module stays cheap.
    """
    from fastmcp import FastMCP

    mcp = FastMCP(name=app_env.app_name)
    _register_mcp_apps(mcp, ui_url=ui_url, apps=apps)
    return mcp.http_app(path="/")


def _register_mcp_apps(mcp: "FastMCP", *, ui_url: str, apps: Sequence[McpApp]) -> None:
    """Surface every supplied MCP App on ``mcp`` as a ``ui://`` resource plus its tool."""
    base = ui_url.rstrip("/")

    # The view must be a zero-arg function; a parameter would make FastMCP treat it as a
    # resource template. A factory binds each app's html without adding one.
    def _make_view(target: McpApp) -> Callable[[], str]:
        def _view() -> str:
            return target.build_view(base)

        return _view

    for app in apps:
        # frameDomains must include this origin: the host sandbox sets frame-src from it, so an
        # empty value would block a nested <iframe> pointing back at the app's own page.
        mcp.resource(
            app.uri,
            name=f"{app.tool}_view",
            description=app.title,
            meta={"ui": {"csp": {"frameDomains": [base, *app.extra_frame_domains]}}},
        )(_make_view(app))
        mcp.tool(
            name=app.tool,
            description=app.description,
            meta={"ui": {"resourceUri": app.uri, "visibility": ["model", "app"]}},
        )(app.tool_fn)


_CONNECTOR_DESCRIPTION = "Solutions Capabilities app MCP server (apps + tools)."
# Registration validates the endpoint's reachability, so it runs after the server is
# serving through its public URL and retries while the server (and, in local dev, the
# tunnel) finish coming up.
_CONNECTOR_MAX_ATTEMPTS = 10
_CONNECTOR_RETRY_DELAY_S = 3.0


async def _upsert_connector(client: Mistral, *, name: str, server: str, visibility: str) -> None:
    """Create or reconcile the self-connector so `name` points at `server` with `visibility`."""
    existing = await client.beta.connectors.list_async()
    match = next((c for c in existing.items if c.name == name), None)
    if match is not None and getattr(match, "visibility", visibility) in (None, visibility):
        if getattr(match, "server", None) != server:
            await client.beta.connectors.update_async(connector_id=match.id, server=server)
            logger.info("Repointed self MCP connector %r -> %s", name, server)
        return
    # No match, or visibility drifted (update_async cannot change it, so recreate).
    if match is not None:
        await client.beta.connectors.delete_async(connector_id=match.id)
    await client.beta.connectors.create_async(
        name=name, description=_CONNECTOR_DESCRIPTION, server=server, visibility=visibility
    )
    logger.info("Registered self MCP connector %r -> %s", name, server)


async def ensure_app_connector(
    client_factory: Callable[[], Mistral],
    *,
    enabled: bool,
    name: str,
    server: str | None,
    visibility: str,
    max_attempts: int = _CONNECTOR_MAX_ATTEMPTS,
    retry_delay_s: float = _CONNECTOR_RETRY_DELAY_S,
) -> None:
    """Upsert this app's own MCP server as an allow_mcp_ui connector.

    Self-heals on URL rotation (tunnels) and visibility drift. Retries while the endpoint comes up.
    Fail-soft, so a connector-API hiccup never blocks startup. Surfacing is opt-in and needs a
    public ``server``, so without both this is a no-op the caller can spawn unconditionally. A
    factory, not a client, keeps construction behind that gate: building a client errors when no API
    key is set, which is the normal state when surfacing is off.
    """
    if not enabled or server is None:
        return
    client = client_factory()
    for attempt in range(max_attempts):
        try:
            await _upsert_connector(client, name=name, server=server, visibility=visibility)
            return
        except Exception:
            if attempt == max_attempts - 1:
                logger.exception("Could not ensure self MCP connector %r; MCP-app surfacing may be unavailable", name)
                return
            await asyncio.sleep(retry_delay_s)
