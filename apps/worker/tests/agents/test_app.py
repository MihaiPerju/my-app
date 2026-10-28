"""Census of the orchestrator assembled from installed capability contributions.

The Unified Harness has no subagents: the orchestrator is one `agents.Agent` whose `Harness` merges
every installed capability's contributions -- search's tools, the 15 connector slots, the guardrail
hook (mcp-apps' `allow_mcp_ui` connector is off by default, so it is not in the roster). This pins
that assembled surface.

The expected surface is derived from the app's installed selection (`.mistral/capabilities.json`),
so the census holds for any composition: `--caps chat` alone expects no tools, no connectors and no
hook, and a later `mistral apps capability add search` expects search's five tools without an edit
here. What the app contributes itself goes in the `APP_*` sets below.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from mistralai.vibe_agents.sdk.app import AgentApp, load_app

APP_ROOT = Path(__file__).resolve().parents[4]
PROJECT_ROOT = APP_ROOT / "apps" / "worker" / "src" / "worker" / "agents"
INSTALLED_MANIFEST = APP_ROOT / ".mistral" / "capabilities.json"

PROJECT_MANIFEST = json.loads((PROJECT_ROOT / "project.json").read_text())

# The registry these capabilities come from: the first segment of an installed `registry/kind/id`.
REGISTRY = "mistralai-capabilities"

# What each capability contributes to the orchestrator Harness, keyed by its full installed identity
# (`registry/kind/id`, as `.mistral/capabilities.json` records it). A bare id is not an identity: the
# same id can exist under another kind or in another registry, and must not inherit these names. A
# capability that vendors a file into `worker/agents/{tools,connectors,hooks}/` adds its names under
# its own entry here; the registry test `agents-census.test.ts` fails when one is missing or listed
# under another capability.
CAPABILITY_TOOLS: dict[str, set[str]] = {
    # search's five retrieval tools (one file each under tools/).
    f"{REGISTRY}/feature/search": {"search_search", "search_open", "search_navigate", "search_read", "search_grep"},
}
CAPABILITY_CONNECTORS: dict[str, set[str]] = {
    # The 15 connector slots, one file per connector under connectors/.
    f"{REGISTRY}/feature/connectors": {
        "atlassian",
        "box",
        "github",
        "gmail",
        "google_calendar",
        "google_drive",
        "linear",
        "notion",
        "outlook",
        "outlook_calendar",
        "sharepoint",
        "sharepoint_graph",
        "sharepoint_online",
        "slack",
        "stripe",
    },
    # mcp-apps vendors connectors/mcp_apps.py, but its `allow_mcp_ui` slot is off by default.
    f"{REGISTRY}/feature/mcp-apps": set(),
}
CAPABILITY_HOOKS: dict[str, set[str]] = {
    # The guardrailing capability contributes a single root hook via hooks/guardrail.py.
    f"{REGISTRY}/feature/guardrailing": {"GuardrailHook"},
}

# This app's own contributions: add the names of the tools, connectors and hooks you vendor into
# `worker/agents/{tools,connectors,hooks}/` yourself.
APP_TOOLS: set[str] = set()
APP_CONNECTORS: set[str] = set()
APP_HOOKS: set[str] = set()


def installed_capability_ids(manifest_path: Path = INSTALLED_MANIFEST) -> set[str]:
    """The full identity (`registry/kind/id`) of every installed capability."""
    if not manifest_path.exists():
        pytest.fail(f"{manifest_path} is missing: the census derives its expectations from it")
    manifest = json.loads(manifest_path.read_text())
    return {entry["capability"] for entry in manifest["installed"]}


def expected(
    contributions: dict[str, set[str]],
    app_own: set[str],
    installed: set[str] | None = None,
) -> set[str]:
    if installed is None:
        installed = installed_capability_ids()
    names = set(app_own)
    for capability_id, contributed in contributions.items():
        if capability_id in installed:
            names |= contributed
    return names


@pytest.fixture(scope="module")
def app() -> AgentApp:
    return load_app(PROJECT_ROOT)


def test_expectations_key_on_the_full_identity_not_the_bare_id(tmp_path: Path) -> None:
    # A `search` under another kind or from another registry is a different capability: it does not
    # vendor search's tools, so the census must not expect them.
    manifest = tmp_path / "capabilities.json"
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 4,
                "installed": [
                    {"capability": "other-registry/feature/search", "version": "1.0.0"},
                    {"capability": f"{REGISTRY}/tooling/search", "version": "1.0.0"},
                    {"capability": f"{REGISTRY}/feature/guardrailing", "version": "1.0.0"},
                ],
            }
        )
    )
    installed = installed_capability_ids(manifest)
    assert expected(CAPABILITY_TOOLS, set(), installed) == set()
    assert expected(CAPABILITY_HOOKS, set(), installed) == {"GuardrailHook"}


def test_checks_use_the_root_workspace_environment() -> None:
    targets = PROJECT_MANIFEST["targets"]
    assert "--no-sync" in targets["typecheck"]["options"]["command"]


def test_typecheck_reads_the_project_not_a_pyproject_as_ty_toml() -> None:
    # `ty check --config-file <pyproject.toml>` parses the file as a ty.toml and rejects
    # `[dependency-groups]`; `--project` reads `[tool.ty]` from the pyproject instead.
    command = PROJECT_MANIFEST["targets"]["typecheck"]["options"]["command"]
    assert "--config-file" not in command
    assert "--project apps/worker/src/worker/agents" in command


def test_project_and_orchestrator_name(app: AgentApp) -> None:
    assert app.name == "app-orchestrator"
    assert app.agent.name == "app-orchestrator"


def test_orchestrator_model_comes_from_the_environment() -> None:
    # A fresh interpreter: the agent is built at import time, so the variable must be set before it.
    probe = subprocess.run(
        [sys.executable, "-c", "from worker.agents.agent import agent; print(agent.model)"],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "ORCHESTRATOR_MODEL": "mistral-large-latest"},
    )
    assert probe.stdout.strip() == "mistral-large-latest"


def test_orchestrator_tool_surface(app: AgentApp) -> None:
    assert {tool.name for tool in app.harness.tools} == expected(CAPABILITY_TOOLS, APP_TOOLS)


def test_connector_roster(app: AgentApp) -> None:
    roster = {slot.connector_name for slot in app.harness.connectors}
    assert roster == expected(CAPABILITY_CONNECTORS, APP_CONNECTORS)


def test_installed_hooks_are_mounted(app: AgentApp) -> None:
    assert {type(hook).__name__ for hook in app.harness.hooks} == expected(CAPABILITY_HOOKS, APP_HOOKS)


def test_the_legacy_subagents_tree_is_gone() -> None:
    # The Unified Harness has no subagents; contributions arrive through per-kind contribution packages instead.
    assert not (PROJECT_ROOT / "subagents").exists()
