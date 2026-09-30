import asyncio

import httpx
import pytest
from cli.commands import agents
from env.vibe_agents import BUILTIN_AGENT_NAME
from env.vibe_agents import Env as VibeAgentsEnv
from structlog.testing import capture_logs


def _agent_row(*, workflow: str = "agents", deployment: str = "dep-1") -> dict[str, object]:
    return {
        "agent_id": "019fb3d4-241e-74d3-85dd-2565c03070db",
        "agent_name": "our-agent",
        "workflow_name": workflow,
        "deployment_name": deployment,
        "is_active": True,
    }


def _configure_agents_step(monkeypatch: pytest.MonkeyPatch, *, conflict_row: dict[str, object] | None) -> None:
    monkeypatch.setattr(agents.vibe_env, "vibe_agents_agent_name", "our-agent")
    monkeypatch.setattr(agents.vibe_env, "vibe_agents_application_name", "vibe_code_web")
    monkeypatch.setattr(agents.mistral_env, "mistral_api_key", "test-key")
    monkeypatch.setenv("DEPLOYMENT_NAME", "dep-1")

    async def _register(**_kwargs: object) -> httpx.Response:
        status = 409 if conflict_row is not None else 201
        return httpx.Response(status, json=_agent_row(), request=httpx.Request("POST", "http://cp/agents/register"))

    async def _list(**_kwargs: object) -> httpx.Response:
        items = [conflict_row] if conflict_row is not None else []
        return httpx.Response(200, json={"items": items}, request=httpx.Request("GET", "http://cp/agents"))

    monkeypatch.setattr(agents, "register_agent", _register)
    monkeypatch.setattr(agents, "list_agents", _list)


def test_reregistering_the_same_binding_is_a_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ordinary case: every deploy re-runs this step against a binding that already matches."""
    _configure_agents_step(monkeypatch, conflict_row=_agent_row())

    asyncio.run(agents.main())


def test_a_binding_pointing_at_another_deployment_fails_the_step(monkeypatch: pytest.MonkeyPatch) -> None:
    """The control plane has no rebind, so a 409 that disagrees must stop the deploy.

    Passing it over is what silently dispatches chat to a worker that no longer runs — the
    failure mode this whole check exists to prevent, and one nothing else would surface.
    """
    _configure_agents_step(monkeypatch, conflict_row=_agent_row(deployment="a-retired-deployment"))

    with pytest.raises(agents.StaleAgentBindingError, match="a-retired-deployment"):
        asyncio.run(agents.main())


def test_a_name_owned_by_another_workspace_fails_the_step(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_agents_step(monkeypatch, conflict_row=None)
    monkeypatch.setattr(
        agents,
        "register_agent",
        lambda **_kwargs: _conflict_without_a_visible_row(),
    )

    with pytest.raises(agents.StaleAgentBindingError, match="not visible in this workspace"):
        asyncio.run(agents.main())


def test_a_deployment_with_no_key_skips_registration(monkeypatch: pytest.MonkeyPatch) -> None:
    """Registration is the app acting as itself, so without its own key there is nothing to act with."""
    _configure_agents_step(monkeypatch, conflict_row=None)
    monkeypatch.setattr(agents.mistral_env, "mistral_api_key", None)
    monkeypatch.setattr(agents, "register_agent", _refuse)

    asyncio.run(agents.main())


async def _refuse(**_kwargs: object) -> httpx.Response:
    raise AssertionError("registration was attempted with no key to attempt it with")


async def _conflict_without_a_visible_row() -> httpx.Response:
    return httpx.Response(409, json={}, request=httpx.Request("POST", "http://cp/agents/register"))


def test_the_builtin_agent_is_not_registered_and_says_what_it_costs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fronting the builtin is allowed, but it must never read as a quiet success."""
    _configure_agents_step(monkeypatch, conflict_row=None)
    monkeypatch.setattr(agents.vibe_env, "vibe_agents_agent_name", BUILTIN_AGENT_NAME)
    monkeypatch.setattr(agents, "register_agent", _refuse)

    with capture_logs() as logs:
        asyncio.run(agents.main())

    [warning] = [entry for entry in logs if entry["log_level"] == "warning"]
    assert "will NOT use this app's orchestrator" in warning["event"]


def test_the_agent_name_defaults_to_this_deployment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unset, chat fronts this deployment's own agent rather than the platform builtin."""
    monkeypatch.delenv("VIBE_AGENTS_AGENT_NAME", raising=False)
    monkeypatch.setenv("DEPLOYMENT_NAME", "deployment-my-app-alice")

    settings = VibeAgentsEnv(_env_file=None)

    assert settings.vibe_agents_agent_name == "deployment-my-app-alice"
    assert not settings.targets_builtin_agent


def test_an_explicit_agent_name_wins_over_the_deployment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIBE_AGENTS_AGENT_NAME", BUILTIN_AGENT_NAME)
    monkeypatch.setenv("DEPLOYMENT_NAME", "deployment-my-app-alice")

    settings = VibeAgentsEnv(_env_file=None)

    assert settings.vibe_agents_agent_name == BUILTIN_AGENT_NAME
    assert settings.targets_builtin_agent
