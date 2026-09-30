"""Which credential chat's calls to the agents API carry, and where they are sent.

Two shapes have to work. Where the deployment can act as its callers the app has no key of its own,
so a call made while serving a request spends that caller's credential. On a Helm deployment nothing
installs one, so the same call goes straight to the public API on ``MISTRAL_API_KEY``. Registration
is neither: it runs outside any request and always uses the app's key.
"""

import asyncio
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import httpx
import pytest
from env.mistral import env as mistral_env
from mistralai_capabilities.chat.vibe import client as vibe_agents
from mistralai_capabilities.chat.vibe.client import VibeAgentsNotConfiguredError
from utils.mistral import CallerCredentials, MistralNotConfiguredError, install_caller_credentials

SESSION_ID = UUID("44444444-4444-4444-4444-444444444444")
PROXY_URL = "https://gateway.test/v1/proxy"


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    """Every request the client would have put on the wire, with its URL and headers."""
    calls: list[dict[str, Any]] = []

    async def _request(_self: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> httpx.Response:
        calls.append({"url": url, "headers": dict(kwargs.get("headers") or {})})
        return httpx.Response(200, json={}, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", _request)
    yield calls
    install_caller_credentials(None)


def _helm(monkeypatch: pytest.MonkeyPatch, *, api_key: str | None = "app-key", base_url: str | None = None) -> None:
    install_caller_credentials(None)
    monkeypatch.setattr(mistral_env, "mistral_api_key", api_key)
    monkeypatch.setattr(mistral_env, "mistral_base_url", base_url)


def _serves_callers(monkeypatch: pytest.MonkeyPatch, *, token: str | None = "tok-caller") -> None:
    def provider() -> CallerCredentials:
        if token is None:
            raise MistralNotConfiguredError("no caller to act for")
        return CallerCredentials(server_url=PROXY_URL, token=token)

    # No key at all, which is the point: a deployment that acts as its callers is not given one.
    monkeypatch.setattr(mistral_env, "mistral_api_key", None)
    install_caller_credentials(provider)


def test_a_deployment_with_no_caller_credential_calls_the_public_api_on_its_own_key(
    monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]
) -> None:
    _helm(monkeypatch)

    asyncio.run(vibe_agents.get_session(session_id=SESSION_ID))

    assert sent[0]["url"] == f"https://api.mistral.ai/v2/agents/sessions/{SESSION_ID}"
    assert sent[0]["headers"]["authorization"] == "Bearer app-key"


def test_a_pinned_base_url_is_honoured(monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]) -> None:
    """The same setting every other capability points at a staging API with."""
    _helm(monkeypatch, base_url="https://api.staging.test/")

    asyncio.run(vibe_agents.get_session(session_id=SESSION_ID))

    assert sent[0]["url"] == f"https://api.staging.test/v2/agents/sessions/{SESSION_ID}"


def test_a_call_acts_for_the_caller_it_is_serving(monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]) -> None:
    """The credential resolves to the person upstream, so tenancy follows them rather than the app."""
    _serves_callers(monkeypatch)

    asyncio.run(vibe_agents.get_session(session_id=SESSION_ID))

    assert sent[0]["url"] == f"{PROXY_URL}/v2/agents/sessions/{SESSION_ID}"
    assert sent[0]["headers"]["authorization"] == "Bearer tok-caller"


def test_two_callers_in_a_row_do_not_share_a_token(monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]) -> None:
    _serves_callers(monkeypatch, token="tok-first")
    asyncio.run(vibe_agents.get_session(session_id=SESSION_ID))
    _serves_callers(monkeypatch, token="tok-second")
    asyncio.run(vibe_agents.get_session(session_id=SESSION_ID))

    assert [call["headers"]["authorization"] for call in sent] == ["Bearer tok-first", "Bearer tok-second"]


def test_registration_runs_on_the_apps_key_even_while_a_caller_is_being_served(
    monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]
) -> None:
    """A deployment registering its own agent is not acting for anybody, so it must not borrow a token."""
    _serves_callers(monkeypatch)
    monkeypatch.setattr(mistral_env, "mistral_api_key", "app-key")
    monkeypatch.setattr(mistral_env, "mistral_base_url", None)

    asyncio.run(vibe_agents.register_agent(agent_name="ours", workflow_name="agents", deployment_name="dep-1"))

    assert sent[0]["url"] == "https://api.mistral.ai/v2/agents/agents/register"
    assert sent[0]["headers"]["authorization"] == "Bearer app-key"


def test_a_request_the_provider_cannot_serve_has_no_caller_to_act_for(
    monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]
) -> None:
    _serves_callers(monkeypatch, token=None)

    with pytest.raises(VibeAgentsNotConfiguredError):
        vibe_agents.ensure_reachable()

    assert sent == []


def test_a_deployment_with_neither_a_caller_credential_nor_a_key_refuses(
    monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]]
) -> None:
    _helm(monkeypatch, api_key=None)

    with pytest.raises(VibeAgentsNotConfiguredError):
        vibe_agents.ensure_reachable()

    assert sent == []


@pytest.mark.parametrize("configure", [_helm, _serves_callers], ids=["helm", "serves_callers"])
def test_either_credential_makes_chat_reachable(
    monkeypatch: pytest.MonkeyPatch, sent: list[dict[str, Any]], configure: Any
) -> None:
    """The positive table. A check that raised unconditionally would satisfy the two above."""
    configure(monkeypatch)

    vibe_agents.ensure_reachable()
