from typing import Any

import pytest
from api.routers.mcp.route import mcp_app
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi.routing import create_api_router


@pytest.fixture
def app() -> FastAPI:
    application = FastAPI()
    router = create_api_router("api.routers")
    application.include_router(router)
    return application


def test_file_router_mounts_mcp_at_top_level(app: FastAPI) -> None:
    with TestClient(app) as client:
        response = client.get("/mcp", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"].endswith("/mcp/")


async def test_mcp_exposes_no_route_derived_tools() -> None:
    server: Any = mcp_app.state.fastmcp_server
    assert await server.list_tools() == []


def test_mcp_transport_is_reachable(app: FastAPI) -> None:
    with TestClient(app) as client:
        response = client.get("/mcp", headers={"accept": "application/json, text/event-stream"})
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "Bad Request: Missing session ID"
