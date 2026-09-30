"""Where the self-connector points: an explicit MCP_SERVER_URL, else the deployed app's public origin."""

import pytest
from env.mcp import Env

_NAMES = ("MCP_SERVER_URL", "__APPS_PUBLIC_ORIGIN", "__SPACES_PUBLIC_ORIGIN")


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        pytest.param({"__APPS_PUBLIC_ORIGIN": "https://demo.apps.test"}, "https://demo.apps.test/mcp", id="apps"),
        pytest.param({"__SPACES_PUBLIC_ORIGIN": "https://demo.apps.test"}, "https://demo.apps.test/mcp", id="spaces"),
        pytest.param({"__APPS_PUBLIC_ORIGIN": "https://demo.apps.test/"}, "https://demo.apps.test/mcp", id="slash"),
        pytest.param(
            {"MCP_SERVER_URL": "https://tunnel.test/mcp", "__APPS_PUBLIC_ORIGIN": "https://demo.apps.test"},
            "https://tunnel.test/mcp",
            id="explicit_wins",
        ),
        pytest.param({"MCP_SERVER_URL": "http://localhost:3000/mcp"}, "http://localhost:3000/mcp", id="local"),
    ],
)
def test_server_url_resolves(monkeypatch: pytest.MonkeyPatch, environ: dict[str, str], expected: str) -> None:
    for name in _NAMES:
        monkeypatch.delenv(name, raising=False)
    for name, value in environ.items():
        monkeypatch.setenv(name, value)

    assert Env(_env_file=None).mcp_server_url == expected


@pytest.mark.parametrize(
    "environ",
    [
        pytest.param({}, id="nothing"),
        pytest.param({"__APPS_PUBLIC_ORIGIN": ""}, id="blank_origin"),
        pytest.param({"MCP_SERVER_URL": "", "__APPS_PUBLIC_ORIGIN": "  "}, id="both_blank"),
    ],
)
def test_server_url_stays_unset(monkeypatch: pytest.MonkeyPatch, environ: dict[str, str]) -> None:
    for name in _NAMES:
        monkeypatch.delenv(name, raising=False)
    for name, value in environ.items():
        monkeypatch.setenv(name, value)

    assert Env(_env_file=None).mcp_server_url is None
