"""The ``allow_mcp_ui`` connector slot mcp-apps contributes to the orchestrator Harness.

That slot is the whole agent-side MCP-app path: the model calls an app tool through it, and the
Unified Harness tags the call so the session UI opens the app's ``ui://`` resource. The slot is
gated on ``MCP_APPS_ENABLED``, read at import, so each case re-imports the module under the setting.
Shipped by ``mcp-apps`` (which depends on ``agents``); runs in the full generated app.
"""

import importlib
from collections.abc import Iterator
from types import ModuleType

import pytest
from env.mcp import env as mcp_env
from worker.agents.connectors import mcp_apps


@pytest.fixture
def reload_with(monkeypatch: pytest.MonkeyPatch) -> Iterator:
    def reload(*, enabled: bool) -> ModuleType:
        monkeypatch.setattr(mcp_env, "mcp_apps_enabled", enabled)
        monkeypatch.setattr(mcp_env, "mcp_connector_name", "demo-app")
        return importlib.reload(mcp_apps)

    yield reload
    monkeypatch.undo()
    importlib.reload(mcp_apps)


def test_enabled_contributes_the_app_self_connector_with_mcp_ui(reload_with) -> None:
    connector = reload_with(enabled=True).connector

    assert connector.connector_name == "demo-app"
    assert connector.allow_mcp_ui is True


def test_disabled_opts_out_of_the_harness(reload_with) -> None:
    assert reload_with(enabled=False).connector is None
