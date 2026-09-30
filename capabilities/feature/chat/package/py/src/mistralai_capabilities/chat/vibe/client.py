"""HTTP adapter for the agents session API at ``/v2/agents``.

This forwards rather than models: it lacks ``SessionsClient``'s per-frame parsing, so raw SSE and
``dict`` bodies keep the vendor wire the browser validates intact (D1, D29).

Two credentials, the same split as ``utils.mistral``. A call made while serving a request spends
the credential the deployment installed for callers, so tenancy and identity come from the person
who made it. Everything else, and every deployment that installs none, goes direct on
``MISTRAL_API_KEY``.
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
from env.mistral import env as mistral_env
from env.vibe_agents import env
from utils.mistral import MistralNotConfiguredError, caller_credentials

# A session the control plane will not run again. The chat stream stops following at these
# rather than holding a connection open against a session that can emit nothing further.
TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "terminated"})

_AGENTS_PATH = "/v2/agents"
_PUBLIC_API = "https://api.mistral.ai"


class VibeAgentsNotConfiguredError(RuntimeError):
    """Raised when a call is attempted with no credential that could authenticate it."""


def _service_endpoint() -> tuple[str, dict[str, str]]:
    """Where to reach the agents API as the app itself, for work that belongs to no caller."""
    if not mistral_env.mistral_api_key:
        raise VibeAgentsNotConfiguredError("MISTRAL_API_KEY is not configured, so /chat cannot reach the agents API")
    base_url = (mistral_env.mistral_base_url or _PUBLIC_API).rstrip("/")
    return f"{base_url}{_AGENTS_PATH}", {"authorization": f"Bearer {mistral_env.mistral_api_key}"}


def _caller_endpoint() -> tuple[str, dict[str, str]]:
    """Where to reach the agents API as whoever made the request being served.

    A caller credential is the identity, so every session a person opens is filed against them
    upstream. Without one the app has a single key and every caller shares the principal it resolves
    to, which is why the mount tags each session with its owner as well.
    """
    try:
        credentials = caller_credentials()
    except MistralNotConfiguredError as error:
        raise VibeAgentsNotConfiguredError(str(error)) from error
    if credentials is None:
        return _service_endpoint()
    return (
        f"{credentials.server_url.rstrip('/')}{_AGENTS_PATH}",
        {"authorization": f"Bearer {credentials.token}"},
    )


# The transient trio: a gateway momentarily unable to relay the request, not a verdict on it.
# Retried once because every mutating call here is idempotent server-side (content-addressed or a
# client-minted id the platform deduplicates on), so a replay converges instead of duplicating.
_RETRY_STATUSES = frozenset({502, 503, 504})
_MAX_ATTEMPTS = 2


async def _send_with_retry(
    send: Callable[[], Awaitable[httpx.Response]],
    *,
    on_retry: Callable[[httpx.Response], None] | None = None,
) -> httpx.Response:
    """Send once, retrying only a transient status and only within the attempt budget."""
    for attempt in range(_MAX_ATTEMPTS):
        response = await send()
        if response.status_code in _RETRY_STATUSES and attempt < _MAX_ATTEMPTS - 1:
            if on_retry is not None:
                on_retry(response)
            continue
        return response
    raise RuntimeError("unreachable")


async def _request(
    method: Literal["GET", "POST", "DELETE"],
    path: str,
    *,
    as_service: bool = False,
    json_body: Any | None = None,
    params: Mapping[str, str] | None = None,
) -> httpx.Response:
    base_url, headers = _service_endpoint() if as_service else _caller_endpoint()
    async with httpx.AsyncClient(timeout=env.vibe_agents_timeout_seconds) as client:
        return await _send_with_retry(
            lambda: client.request(method, f"{base_url}{path}", headers=headers, json=json_body, params=params)
        )


def ensure_reachable() -> None:
    """Raise if this request has nothing that could authenticate a call to the agents API."""
    _caller_endpoint()


async def create_session_with_command(
    *,
    agent_name: str,
    command: dict[str, Any],
    client_session_id: UUID | None = None,
    app_context: dict[str, Any] | None = None,
) -> httpx.Response:
    """Open a session, carrying ``command`` as its first turn.

    ``client_session_id`` is the control plane's exact-retry identity: reuse it on a retry so the
    same value converges on one session. The body is assembled here so a caller cannot set the
    fields it must not choose (the agent, application, toolsets, and skills).
    """
    body: dict[str, Any] = {
        "client_session_id": str(client_session_id or uuid4()),
        "application_name": env.vibe_agents_application_name,
        "agent_name": agent_name,
        "initial_command": command,
    }
    if app_context is not None:
        body["app_context"] = app_context
    # `principal` is deliberately absent from the body. The API derives it from the credential and
    # 403s on any supplied value that disagrees, so omitting it removes the disagreement entirely.
    return await _request("POST", "/sessions", json_body=body)


async def get_session(*, session_id: UUID) -> httpx.Response:
    return await _request("GET", f"/sessions/{session_id}")


async def list_sessions(*, limit: int = 50, cursor: str | None = None) -> httpx.Response:
    params = {"limit": str(limit)}
    if cursor is not None:
        params["cursor"] = cursor
    return await _request("GET", "/sessions", params=params)


async def submit_command(*, session_id: UUID, command: Any) -> httpx.Response:
    return await _request("POST", f"/sessions/{session_id}/commands", json_body=command)


async def submit_message(*, session_id: UUID, message: str, command_id: UUID | None = None) -> httpx.Response:
    return await submit_command(session_id=session_id, command=_message_command(message, command_id=command_id))


async def cancel_session(*, session_id: UUID, reason: str = "cancelled by the caller") -> httpx.Response:
    return await submit_command(
        session_id=session_id,
        command={
            "type": "cancel_session",
            "command_id": str(uuid4()),
            "source": env.vibe_agents_application_name,
            "reason": reason,
        },
    )


async def submit_callback_result(*, session_id: UUID, callback_id: UUID, result: Any) -> httpx.Response:
    return await _request("POST", f"/sessions/{session_id}/callbacks/{callback_id}", json_body={"result": result})


async def read_events_history(*, session_id: UUID, limit: int, cursor: str | None = None) -> httpx.Response:
    params = {"limit": str(limit)}
    if cursor is not None:
        params["cursor"] = cursor
    return await _request("GET", f"/sessions/{session_id}/events/history", params=params)


async def stream_session_events(*, session_id: UUID, cursor: str | None = None) -> AsyncIterator[bytes]:
    """Tail a session's SSE stream, forwarding the control plane's own bytes.

    Raw rather than parsed, because the proxy route's client validates the vendor frame itself;
    decoding here would risk an encoding difference the browser sees. No read timeout: the stream is
    idle between turns by design and sends a heartbeat every 15s, which a deadline would sever.
    """
    params = {"cursor": cursor} if cursor is not None else None
    base_url, auth_headers = _caller_endpoint()
    headers = {**auth_headers, "accept": "text/event-stream"}
    timeout = httpx.Timeout(env.vibe_agents_timeout_seconds, read=None)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "GET", f"{base_url}/sessions/{session_id}/events", headers=headers, params=params
        ) as response:
            response.raise_for_status()
            async for chunk in response.aiter_raw():
                yield chunk


async def register_agent(*, agent_name: str, workflow_name: str, deployment_name: str) -> httpx.Response:
    """Bind ``agent_name`` to a workflow this deployment's worker already serves.

    A 409 means the name is taken in this workspace, which for an init step that runs on every
    deploy is the ordinary outcome rather than a failure; the caller decides.
    """
    return await _request(
        "POST",
        "/agents/register",
        as_service=True,
        json_body={
            "agent_name": agent_name,
            "workflow_name": workflow_name,
            "deployment_name": deployment_name,
        },
    )


async def list_agents(*, limit: int = 200) -> httpx.Response:
    """The agents this workspace can address, builtins included."""
    return await _request("GET", "/agents", as_service=True, params={"limit": str(limit)})


def _message_command(message: str, *, command_id: UUID | None = None) -> dict[str, Any]:
    return {
        "type": "message",
        "command_id": str(command_id or uuid4()),
        "source": env.vibe_agents_application_name,
        "message": {"role": "user", "parts": [{"type": "text", "text": message}]},
    }


def decode(response: httpx.Response) -> Any:
    """The response body as JSON, or ``None`` for the empty bodies 204s carry."""
    if not response.content:
        return None
    return json.loads(response.content)
