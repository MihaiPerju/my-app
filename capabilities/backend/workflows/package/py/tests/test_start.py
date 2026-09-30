"""Workflow dispatch helper tests."""

import importlib

import pytest


def _load_start_module():
    return importlib.import_module("mistralai_capabilities.workflows.cli.start")


def test_unknown_workflow_fails_locally_with_the_available_names(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bad `--workflow` must fail before dispatch, listing what discovery found.

    Resolution is caller-side here (the worker owns runtime discovery), so the command re-runs the
    SDK scan and turns a miss into a local `SystemExit` rather than a failed platform execution.
    """
    start = _load_start_module()
    monkeypatch.setattr(start.workflows_sdk, "discover_all_workflows_in_package", lambda _package: [])

    with pytest.raises(SystemExit) as excinfo:
        start._resolve_workflow("nope")

    message = str(excinfo.value)
    assert "no workflow named 'nope'" in message
    assert "(none discovered)" in message
