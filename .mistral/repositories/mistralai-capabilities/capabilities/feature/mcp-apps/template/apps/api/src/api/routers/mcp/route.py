"""The MCP Apps server, mounted at ``/mcp`` by the file router."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from env.mcp import env as mcp_env
from env.mistral import env as mistral_env
from fastapi import APIRouter
from fastmcp.utilities.lifespan import combine_lifespans
from mistralai.client import Mistral
from mistralai_capabilities.mcp_apps.discovery import discover_mcp_apps
from mistralai_capabilities.mcp_apps.server import create_mcp_app, ensure_app_connector

logger = logging.getLogger(__name__)


def _mistral_client() -> Mistral:
    return Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)


async def _drain(task: asyncio.Task[None]) -> None:
    task.cancel()
    await asyncio.wait([task])
    if not task.cancelled() and (failure := task.exception()) is not None:
        logger.warning("startup task failed", exc_info=failure)


@asynccontextmanager
async def _connector_lifespan(_app: object) -> AsyncIterator[None]:
    connector = asyncio.create_task(
        ensure_app_connector(
            _mistral_client,
            enabled=mcp_env.mcp_apps_enabled,
            name=mcp_env.mcp_connector_name,
            server=mcp_env.mcp_server_url,
            visibility=mcp_env.mcp_connector_visibility,
        ),
        name="ensure_app_connector",
    )
    try:
        yield
    finally:
        await _drain(connector)


mcp_app = create_mcp_app(ui_url=mcp_env.mcp_app_ui_url, apps=discover_mcp_apps("api.mcp_apps"))
router = APIRouter(lifespan=combine_lifespans(_connector_lifespan, mcp_app.lifespan))
router.mount("", mcp_app)
