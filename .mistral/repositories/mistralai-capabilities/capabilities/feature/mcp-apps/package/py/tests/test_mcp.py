import importlib
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from textwrap import dedent

import pytest
from mistralai_capabilities.mcp_apps.discovery import McpAppDiscoveryError, discover_mcp_apps

_DECLARATION = dedent(
    """
    from mistralai_capabilities.mcp_apps.contract import McpApp

    app = McpApp(
        tool="{tool}",
        uri="{uri}",
        title="{tool}",
        description="Open {tool}",
        build_view=lambda _base: "<main />",
        tool_fn=lambda: {{}},
    )
    """
)


def _declaration(tool: str, uri: str | None = None) -> str:
    return _DECLARATION.format(tool=tool, uri=uri or f"ui://mcp-app/{tool}")


@pytest.fixture
def catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """An importable, empty ``mcp_apps`` package that tests fill in with modules.

    Laid down on disk rather than faked: the scan's whole job is to turn a directory into a
    catalog, and a stubbed ``pkgutil`` would assert nothing about that.
    """
    package = tmp_path / "mcp_apps"
    package.mkdir()
    (package / "__init__.py").write_text('"""Test catalog."""\n')
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()
    yield package
    for name in [name for name in sys.modules if name.startswith("mcp_apps")]:
        del sys.modules[name]


def test_contract_import_does_not_load_api_runtime_or_feature_packages() -> None:
    """Importing the contract must stay cheap, because every declared app imports it.

    ``server`` is a sibling module that pulls FastMCP and the workflows plugin, but a sibling never
    loads implicitly; only the empty package ``__init__`` runs. This test keeps it empty.
    ``discovery`` is probed too, because the host imports it at boot and must not reach any of this.
    """
    code = dedent(
        """
        import importlib
        import json
        import sys

        importlib.import_module("mistralai_capabilities.mcp_apps.contract")
        importlib.import_module("mistralai_capabilities.mcp_apps.discovery")

        forbidden_exact = {"fastapi", "fastmcp"}
        forbidden_prefixes = (
            "fastapi.",
            "fastmcp.",
            "mistralai.workflows.plugins",
        )
        # Any capability toolkit other than this one. The MCP-app contract is delivery: it must not
        # drag a feature in. Expressed as "not mcp" rather than a list of capability names, which
        # would miss the next one the day it lands.
        loaded = sorted(
            name
            for name in sys.modules
            if name in forbidden_exact
            or any(name.startswith(prefix) for prefix in forbidden_prefixes)
            or (name.startswith("mistralai_capabilities.") and not name.startswith("mistralai_capabilities.mcp_apps"))
        )
        print(json.dumps(loaded))
        raise SystemExit(1 if loaded else 0)
        """
    )

    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(path for path in sys.path if path)
    result = subprocess.run(
        [sys.executable, "-c", code],
        check=False,
        env=env,
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, json.loads(result.stdout or "[]")


def test_a_composition_without_the_package_serves_an_empty_catalog() -> None:
    """The registry's own test run is exactly this case: no generated app, so no `mcp_apps`."""
    assert discover_mcp_apps("mcp_apps_that_no_composition_ships") == []


def test_a_package_with_no_modules_has_no_mcp_apps(catalog: Path) -> None:
    assert discover_mcp_apps("mcp_apps") == []


def test_every_module_level_app_is_discovered_in_module_order(catalog: Path) -> None:
    package = catalog
    (package / "checkout.py").write_text(_declaration("checkout"))
    (package / "account.py").write_text(_declaration("account"))

    assert [app.tool for app in discover_mcp_apps("mcp_apps")] == ["account", "checkout"]


def test_an_app_that_ships_assets_declares_itself_in_the_subpackage_init(catalog: Path) -> None:
    """The natural layout for an app with a view template: a directory, declaration in `__init__`.

    A one-level scan reaches it, because `mcp_apps.account` is a child of `mcp_apps` and importing
    it runs that `__init__.py`. A deeper walk is not wanted: it would also surface
    `account/helpers.py`, which is not an app.
    """
    nested = catalog / "account"
    nested.mkdir()
    (nested / "__init__.py").write_text(_declaration("account_summary"))
    (nested / "view.html").write_text("<main />")

    assert [app.tool for app in discover_mcp_apps("mcp_apps")] == ["account_summary"]


def test_a_subpackage_that_cannot_be_imported_names_itself(catalog: Path) -> None:
    nested = catalog / "billing"
    nested.mkdir()
    (nested / "__init__.py").write_text("raise RuntimeError('configuration missing')\n")

    with pytest.raises(McpAppDiscoveryError, match="could not be imported") as failure:
        discover_mcp_apps("mcp_apps")

    assert "mcp_apps.billing" in str(failure.value)


def test_a_module_that_cannot_be_imported_names_itself(catalog: Path) -> None:
    package = catalog
    (package / "billing.py").write_text("raise RuntimeError('configuration missing')\n")

    with pytest.raises(McpAppDiscoveryError, match="could not be imported") as failure:
        discover_mcp_apps("mcp_apps")

    assert "mcp_apps.billing" in str(failure.value)
    assert "configuration missing" in str(failure.value)


def test_an_mcp_app_under_another_name_is_not_a_declaration(catalog: Path) -> None:
    """A module holds an `McpApp` for its own reasons; only `app` declares one.

    A sibling import like `from mcp_apps.shared import featured` matters most. A type-wide scan
    would count it as a second declaration, reject it as a duplicate tool, and abort startup over
    a module that declared nothing.
    """
    package = catalog
    (package / "shared.py").write_text(_declaration("shared").replace("app = McpApp", "featured = McpApp"))
    (package / "account.py").write_text(
        _declaration("account") + "\nfrom mcp_apps.shared import featured  # noqa: E402,F401\n"
    )

    assert [app.tool for app in discover_mcp_apps("mcp_apps")] == ["account"]


def test_a_declaration_that_is_not_an_mcp_app_is_rejected(catalog: Path) -> None:
    package = catalog
    (package / "billing.py").write_text("app = 'not an McpApp'\n")

    with pytest.raises(McpAppDiscoveryError, match="is str, not an McpApp"):
        discover_mcp_apps("mcp_apps")


def test_a_module_declaring_no_app_is_not_an_error(catalog: Path) -> None:
    package = catalog
    (package / "helpers.py").write_text("BASE = 'ui://mcp-app'\n")
    (package / "account.py").write_text(_declaration("account"))

    assert [app.tool for app in discover_mcp_apps("mcp_apps")] == ["account"]


@pytest.mark.parametrize(
    ("second_tool", "second_uri", "message"),
    [
        ("summary", "ui://mcp-app/billing", "duplicate MCP tool"),
        ("invoice", "ui://mcp-app/account", "duplicate MCP resource URI"),
    ],
)
def test_a_surface_claimed_twice_names_both_declarations(
    catalog: Path, second_tool: str, second_uri: str, message: str
) -> None:
    package = catalog
    (package / "account.py").write_text(_declaration("summary", "ui://mcp-app/account"))
    (package / "billing.py").write_text(_declaration(second_tool, second_uri))

    with pytest.raises(McpAppDiscoveryError, match=message) as failure:
        discover_mcp_apps("mcp_apps")

    assert "mcp_apps.account" in str(failure.value)
    assert "mcp_apps.billing" in str(failure.value)


def test_a_module_is_not_a_package(catalog: Path, tmp_path: Path) -> None:
    (tmp_path / "mcp_apps_flat.py").write_text("")

    with pytest.raises(McpAppDiscoveryError, match="is a module, not a package"):
        discover_mcp_apps("mcp_apps_flat")
