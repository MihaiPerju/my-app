"""Agents-owned workflow name and the prompt-registry resolution."""

from types import SimpleNamespace
from unittest.mock import Mock

import httpx
from mistralai.client import models
from mistralai.workflows import get_workflow_definition
from worker.workflows.agents import (
    AgentsSessionWorkflow,
    _resolve_registry_content,
    agents_env,
)


def test_agent_session_workflow_has_a_stable_name() -> None:
    # `agents` is the frozen wire identifier the vibe_agents control plane dispatches to. The Unified
    # Harness has no `type="chat"` promotion, so there is a single session workflow now.
    assert get_workflow_definition(AgentsSessionWorkflow).name == "agents"


def test_agent_session_workflow_exposes_the_control_plane_contract() -> None:
    definition = get_workflow_definition(AgentsSessionWorkflow)

    assert definition.input_schema["title"] == "SessionWorkflowStartInput"
    assert {signal.name for signal in definition.signals} == {"submit_command"}
    # rc4's Unified Harness session workflow dropped the transitional `__temporary_get_session_state`
    # query; `__get_pending_inputs` remains the control-plane read.
    assert {query.name for query in definition.queries} >= {"__get_pending_inputs"}
    # The session workflow may carry SDK-synthesized update operations beyond the app's own; assert
    # __submit_input is present rather than pinning the exact set.
    assert {update.name for update in definition.updates} >= {"__submit_input"}


def _page(*prompts: models.Prompt, token: str | None = None):
    return SimpleNamespace(result=SimpleNamespace(data=list(prompts), next_page_token=token))


def test_registry_resolution_follows_pages_and_returns_content(monkeypatch) -> None:
    monkeypatch.setattr(agents_env, "prompt_registry_name", "app-orchestrator")
    api = SimpleNamespace(list=Mock(), get=Mock())
    api.list.side_effect = [
        _page(models.Prompt(id="other", name="other"), token="next"),
        _page(models.Prompt(id="p-1", name="app-orchestrator")),
    ]
    api.get.return_value = models.Prompt(definition={"content": "live"})
    client = SimpleNamespace(beta=SimpleNamespace(prompts=api))

    assert _resolve_registry_content(client) == "live"
    assert api.list.call_args_list[1].kwargs["page_token"] == "next"


def test_registry_resolution_returns_none_for_blank_or_missing_values(
    monkeypatch,
) -> None:
    monkeypatch.setattr(agents_env, "prompt_registry_name", "app-orchestrator")
    api = SimpleNamespace(list=Mock(), get=Mock())
    client = SimpleNamespace(beta=SimpleNamespace(prompts=api))
    api.list.return_value = _page()
    assert _resolve_registry_content(client) is None

    api.list.return_value = _page(models.Prompt(id="p-1", name="app-orchestrator"))
    api.get.return_value = models.Prompt(definition={"content": "   "})
    assert _resolve_registry_content(client) is None


def test_registry_transport_failure_does_not_abort_startup() -> None:
    api = SimpleNamespace(list=Mock(), get=Mock())
    api.list.side_effect = httpx.ConnectError("offline")
    client = SimpleNamespace(beta=SimpleNamespace(prompts=api))

    assert _resolve_registry_content(client) is None
