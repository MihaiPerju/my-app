"""Roster check for the connector slots this capability contributes to the orchestrator Harness.

The Unified Harness has no subagents: the 15 external-service connectors are ``agents.connector("<key>")``
slots, one file per connector under ``worker/agents/connectors/`` (each exposing a module-level
``connector``), which ``mistralai_capabilities.agents.assembly.assemble_harness`` merges into the single orchestrator
``Harness``. This pins the roster -- each expected key ships its own file and that file declares that
key -- and guards that the old ``subagents/(studio)/(connectors)`` tree is gone. The SEMANTIC contract
(the slots actually reach the assembled Harness, exactly this set) is asserted once, canonically, by the
``agents`` capability's ``test_app.py`` through ``assemble_harness``; re-proving it here would be
redundant.
"""

import importlib
from pathlib import Path

from worker.agents import connectors as connectors_pkg

AGENTS_ROOT = Path(__file__).resolve().parent.parent / "src" / "worker" / "agents"
CONNECTORS_DIR = AGENTS_ROOT / "connectors"

# The 15 connector keys, each a connector already configured for the workspace. The near-duplicate
# SharePoint/Outlook keys are distinct workspace-configured connectors, not typos. Add or remove a
# key here and as connectors/<key>.py together.
EXPECTED_CONNECTOR_KEYS = {
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
}


def test_every_expected_connector_ships_its_own_file() -> None:
    for key in EXPECTED_CONNECTOR_KEYS:
        assert (CONNECTORS_DIR / f"{key}.py").exists(), f"missing connectors/{key}.py"


def test_each_connector_file_declares_its_own_key() -> None:
    # One file per connector, named by its key: connectors/<key>.py exposes connector for that key.
    for key in EXPECTED_CONNECTOR_KEYS:
        module = importlib.import_module(f"{connectors_pkg.__name__}.{key}")
        assert module.connector.connector_name == key, (
            f"connectors/{key}.py declares {module.connector.connector_name!r}, expected {key!r}"
        )


def test_no_connector_subagents_remain() -> None:
    stale = AGENTS_ROOT / "subagents" / "(studio)" / "(connectors)"
    assert not stale.exists(), f"connectors are slots now, not subagents; delete {stale}"
