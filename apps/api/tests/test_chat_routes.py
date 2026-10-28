"""The chat session surface, and the things about it that are not obvious.

Two people must not see each other's chats. Upstream cannot tell them apart when the app holds one
API key, so the mount tags each session it opens with the app user who opened it and filters on
that tag; the agent name is filtered the same way, because upstream does not scope by it either
(D3). The other cases: the request allowlist, the stream deciding its status before streaming, and
the conversation list titling itself from ``app_context`` because upstream's generator is disabled.
"""

from collections import Counter
from typing import Any
from uuid import UUID

import httpx
import pytest
from env.mistral import env as mistral_env
from env.vibe_agents import env as vibe_env
from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from mistralai_capabilities.chat.vibe.router import _REFUSED, _UNKNOWN, _unwrap
from mistralai_capabilities.chat.vibe.sessions import _sessions
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.fastapi.openapi import HTTP_METHODS, untyped_json_responses
from mistralai_capabilities.fastapi.routing import anonymous_paths
from starlette.routing import Route
from support.auth import USER_ID, FakeUserStore, auth_headers, auth_hooks
from support.workflows_auth import FakeExecutionStore, FakeExecutor, workflow_auth_hooks
from utils.mistral import install_caller_credentials

# isort: split
from conftest import build_app

# Read rather than hardcoded: the mount binds its agent at import time, so a literal here would
# assert against whatever this environment happens to configure and drift the moment it changes.
AGENT = vibe_env.vibe_agents_agent_name
SESSION_ID = "44444444-4444-4444-4444-444444444444"
CALLBACK_ID = "55555555-5555-5555-5555-555555555555"
OTHER_USER = "99999999-9999-9999-9999-999999999999"
# Valid as a stop command and as a callback result at once, so one table can sweep every
# id-addressed route instead of one table per body shape.
_ANY_BODY = {"type": "cancel_session", "command_id": "66666666-6666-6666-6666-666666666666", "result": {}}
# The wire key the mount writes the owning app user under, spelled out rather than imported so a
# rename has to be made twice and cannot silently orphan every session already stored upstream.
OWNER_KEY = "owner_user_id"
_ANONYMOUS = {f"/api{path}".rstrip("/") or "/" for path in anonymous_paths("api.routers.api.internal")}


def _response(payload: Any, status_code: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code=status_code,
        json=payload,
        request=httpx.Request("GET", "http://upstream"),
    )


def _app_context(owner: str = USER_ID, **extra: Any) -> dict[str, Any]:
    return {OWNER_KEY: owner, **extra}


def _session(agent_name: str = AGENT, status: str = "running", **upstream: Any) -> dict[str, Any]:
    return {
        "agent_session_id": SESSION_ID,
        "agent_name": agent_name,
        "status": status,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "app_context": _app_context(),
        **upstream,
    }


def _open(chat: TestClient, *parts: dict[str, Any], **body: Any) -> httpx.Response:
    command = {
        "type": "message",
        "command_id": "66666666-6666-6666-6666-666666666666",
        "message": {"role": "user", "parts": list(parts)},
    }
    return chat.post(
        "/api/v1/chat/sessions",
        headers=auth_headers(),
        json={"initial_command": command, **body},
    )


class FakeSessions:
    """Records what the mount asked the control plane for, and answers what it is told to."""

    def __init__(self, session: dict[str, Any] | None = None) -> None:
        self.session = session if session is not None else _session()
        self.calls: list[tuple[str, dict[str, Any]]] = []
        # `pages` is served in order, then `page` for every call after that.
        self.pages: list[dict[str, Any]] = []
        self.page: dict[str, Any] = {"items": [], "next": None}
        self.stream_chunks: list[bytes] = []

    def _record(self, name: str, **kwargs: Any) -> None:
        self.calls.append((name, kwargs))

    async def create(self, *, agent_name: str, command: Any, **kwargs: Any) -> httpx.Response:
        self._record("create", agent_name=agent_name, command=command, **kwargs)
        return _response({"agent_session": self.session}, status_code=201)

    async def get(self, *, session_id: UUID) -> httpx.Response:
        self._record("get", session_id=session_id)
        return _response(self.session)

    async def list(self, *, limit: int, cursor: str | None) -> httpx.Response:
        self._record("list", limit=limit, cursor=cursor)
        return _response(self.pages.pop(0) if self.pages else self.page)

    async def submit_command(self, *, session_id: UUID, command: Any) -> httpx.Response:
        self._record("submit_command", session_id=session_id, command=command)
        return _response({"agent_session_id": SESSION_ID, "command_id": command["command_id"]})

    async def submit_callback_result(self, *, session_id: UUID, callback_id: UUID, result: Any) -> httpx.Response:
        self._record("submit_callback_result", session_id=session_id, callback_id=callback_id)
        return _response({"agent_session_id": SESSION_ID, "callback_id": str(callback_id)})

    async def read_events_history(self, *, session_id: UUID, limit: int, cursor: str | None) -> httpx.Response:
        self._record("read_events_history", session_id=session_id, limit=limit, cursor=cursor)
        return _response({"events": [], "nextCursor": None})

    def stream_events(self, *, session_id: UUID, cursor: str | None) -> Any:
        # Sync, like the real adapter: it hands back an async generator rather than awaiting one,
        # so the caller can open the upstream connection lazily when it starts iterating.
        self._record("stream_events", session_id=session_id, cursor=cursor)

        async def chunks() -> Any:
            for chunk in self.stream_chunks:
                yield chunk

        return chunks()


@pytest.fixture
def users() -> FakeUserStore:
    return FakeUserStore()


@pytest.fixture
def executor() -> FakeExecutor:
    return FakeExecutor()


@pytest.fixture
def executions() -> FakeExecutionStore:
    return FakeExecutionStore()


@pytest.fixture
def client(executor: FakeExecutor, users: FakeUserStore, executions: FakeExecutionStore) -> TestClient:
    return TestClient(
        build_app(
            hooks=FastAPIHooks.compose(auth_hooks(users), workflow_auth_hooks(executor, executions)),
            routers="api.routers",
        )
    )


@pytest.fixture
def sessions() -> FakeSessions:
    return FakeSessions()


@pytest.fixture
def chat(client: TestClient, sessions: FakeSessions, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # The Helm shape: nothing installs a caller credential, so chat reaches the agents API on the
    # app's own key. The other shape is covered in test_chat_upstream.py.
    install_caller_credentials(None)
    monkeypatch.setattr(mistral_env, "mistral_api_key", "test-key")
    client.app.dependency_overrides[_sessions] = lambda: sessions
    return client


def test_a_turn_opens_a_session_on_this_mounts_agent(chat: TestClient, sessions: FakeSessions) -> None:
    response = chat.post(
        "/api/v1/chat/sessions",
        headers=auth_headers(),
        json={
            "initial_command": {
                "type": "message",
                "command_id": "66666666-6666-6666-6666-666666666666",
                "message": {
                    "role": "user",
                    "parts": [{"type": "text", "text": "hello"}],
                },
            }
        },
    )

    assert response.status_code == 201
    assert response.json()["agent_session"]["agent_session_id"] == SESSION_ID
    name, kwargs = sessions.calls[0]
    assert name == "create"
    # The mount binds its agent at import, so this is the configured one and never the caller's.
    assert kwargs["agent_name"] == vibe_env.vibe_agents_agent_name


def test_a_caller_cannot_choose_the_agent_or_grant_itself_toolsets(chat: TestClient, sessions: FakeSessions) -> None:
    """The upstream create accepts toolsets and skills. A browser must reach neither."""
    chat.post(
        "/api/v1/chat/sessions",
        headers=auth_headers(),
        json={
            "agent_name": "some-other-agent",
            "toolsets": [{"type": "connector", "name": "prod-database"}],
            "requested_skills": [{"type": "registry_skill", "id": str(UUID(int=9))}],
            "initial_command": {
                "type": "message",
                "command_id": "66666666-6666-6666-6666-666666666666",
                "message": {"role": "user", "parts": [{"type": "text", "text": "hi"}]},
                "source": "spoofed",
            },
        },
    )

    _, kwargs = sessions.calls[0]
    assert kwargs["agent_name"] != "some-other-agent"
    assert "toolsets" not in kwargs
    assert "requested_skills" not in kwargs
    # `source` is upstream's attribution field, so the caller's is replaced rather than dropped:
    # a browser that could set it could disguise this app's traffic as another application's.
    assert kwargs["command"]["source"] == vibe_env.vibe_agents_application_name


def test_a_turn_is_traced_and_labelled_with_the_conversation_it_belongs_to(
    chat: TestClient, sessions: FakeSessions
) -> None:
    """The worker reads `dora_tracing_enabled` off this and nothing else — absent, the agent's
    turn produces no spans at all, and a rating has no trace to sit beside."""
    chat.post(
        f"/api/v1/chat/sessions/{SESSION_ID}/commands",
        headers=auth_headers(),
        json={
            "type": "message",
            "command_id": "66666666-6666-6666-6666-666666666666",
            "message": {"role": "user", "parts": [{"type": "text", "text": "hi"}]},
        },
    )

    command = next(kwargs["command"] for name, kwargs in sessions.calls if name == "submit_command")
    assert command["metadata"]["observability"] == {
        "dora_tracing_enabled": True,
        # The same id the rating carries, which is the whole point: it is what joins a vote to
        # the turn it judges once neither of them has a span id to share.
        "conversation_id": SESSION_ID,
    }


def test_a_caller_cannot_turn_tracing_off_or_relabel_whose_conversation_a_turn_is(
    chat: TestClient, sessions: FakeSessions
) -> None:
    chat.post(
        f"/api/v1/chat/sessions/{SESSION_ID}/commands",
        headers=auth_headers(),
        json={
            "type": "message",
            "command_id": "66666666-6666-6666-6666-666666666666",
            "message": {"role": "user", "parts": [{"type": "text", "text": "hi"}]},
            "metadata": {
                "observability": {
                    "dora_tracing_enabled": False,
                    "conversation_id": "someone-elses",
                }
            },
        },
    )

    command = next(kwargs["command"] for name, kwargs in sessions.calls if name == "submit_command")
    assert command["metadata"]["observability"]["dora_tracing_enabled"] is True
    assert command["metadata"]["observability"]["conversation_id"] == SESSION_ID


def test_the_turn_that_opens_a_session_is_traced_but_cannot_name_the_conversation(
    chat: TestClient, sessions: FakeSessions
) -> None:
    """The id is the control plane's and does not exist yet, and inventing one would label the
    first turn differently from every turn after it."""
    _open(chat, {"type": "text", "text": "hello"})

    _, kwargs = sessions.calls[0]
    assert kwargs["command"]["metadata"]["observability"] == {"dora_tracing_enabled": True}


@pytest.mark.parametrize("stop", ["cancel_session", "interrupt_session"])
def test_a_stop_carries_no_metadata_because_upstream_refuses_one(
    chat: TestClient, sessions: FakeSessions, stop: str
) -> None:
    """The Stop button's whole failure mode, in one assertion.

    Upstream rejects extra fields on stop commands, so stamping the observability block returns 422
    and the turn keeps running. The vendored SDK's `stop()` has no `catch`, so a rejected stop left
    the spinner turning and the answer streaming, with no error anywhere.
    """
    response = chat.post(
        f"/api/v1/chat/sessions/{SESSION_ID}/commands",
        headers=auth_headers(),
        json={
            "type": stop,
            "command_id": "66666666-6666-6666-6666-666666666666",
            "reason": "user pressed stop",
        },
    )

    assert response.status_code == 200
    command = next(kwargs["command"] for name, kwargs in sessions.calls if name == "submit_command")
    assert "metadata" not in command
    # A stop still has to be attributed, so `source` is stamped on it exactly like a turn's:
    # upstream requires the field on every command, and only `metadata` is the forbidden one.
    assert command["source"] == vibe_env.vibe_agents_application_name
    assert command["type"] == stop


def test_reconfiguring_the_agent_is_not_a_command_a_caller_can_send(
    chat: TestClient,
) -> None:
    response = chat.post(
        f"/api/v1/chat/sessions/{SESSION_ID}/commands",
        headers=auth_headers(),
        json={
            "type": "update_agent_configuration",
            "command_id": str(UUID(int=7)),
            "action": "overwrite",
            "agent_configuration": {"toolsets": [{"type": "connector", "name": "prod-database"}]},
        },
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}"),
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}/events"),
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}/events/history"),
        ("POST", f"/api/v1/chat/sessions/{SESSION_ID}/callbacks/{CALLBACK_ID}"),
    ],
)
def test_another_agents_session_is_unknown_to_this_mount(
    chat: TestClient, sessions: FakeSessions, method: str, path: str
) -> None:
    """Upstream scopes by caller but not by agent, so the mount is what closes that gap (D3)."""
    sessions.session = _session(agent_name="a-different-agent")

    response = chat.request(method, path, headers=auth_headers(), json={"result": {}})

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown session"


def test_the_stream_refuses_before_it_starts_streaming(chat: TestClient, sessions: FakeSessions) -> None:
    """A refusal decided inside the generator arrives after the status line, as a broken 200."""
    sessions.session = _session(agent_name="a-different-agent")

    response = chat.get(f"/api/v1/chat/sessions/{SESSION_ID}/events", headers=auth_headers())

    assert response.status_code == 404
    assert "text/event-stream" not in response.headers.get("content-type", "")
    assert not any(call == "stream_events" for call, _ in sessions.calls)


def test_the_stream_forwards_the_control_planes_own_frames(chat: TestClient, sessions: FakeSessions) -> None:
    sessions.stream_chunks = [
        b'id: c1\nevent: session_event\ndata: {"sequence":"c1","event":{"type":"history_update"}}\n\n',
        b": heartbeat\n\n",
    ]

    response = chat.get(f"/api/v1/chat/sessions/{SESSION_ID}/events", headers=auth_headers())

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    # Byte-for-byte, heartbeat included: the browser validates these frames itself, so anything
    # this app re-encodes is a difference only the browser can see.
    assert response.text == "".join(chunk.decode() for chunk in sessions.stream_chunks)


def test_the_stream_resumes_from_the_header_an_sse_client_actually_sends(
    chat: TestClient, sessions: FakeSessions
) -> None:
    """Dropping this replays the whole session on top of the history the client already has, and
    because a history `add` patch inserts rather than overwrites, every message renders twice."""
    chat.get(
        f"/api/v1/chat/sessions/{SESSION_ID}/events",
        headers={**auth_headers(), "Last-Event-ID": "cursor-42"},
    )

    _, kwargs = next((name, kw) for name, kw in sessions.calls if name == "stream_events")
    assert kwargs["cursor"] == "cursor-42"


def test_the_stream_still_accepts_a_cursor_in_the_query(chat: TestClient, sessions: FakeSessions) -> None:
    chat.get(
        f"/api/v1/chat/sessions/{SESSION_ID}/events?cursor=cursor-7",
        headers=auth_headers(),
    )

    _, kwargs = next((name, kw) for name, kw in sessions.calls if name == "stream_events")
    assert kwargs["cursor"] == "cursor-7"


def test_the_header_wins_over_the_query(chat: TestClient, sessions: FakeSessions) -> None:
    """A reconnecting EventSource sets the header itself; whatever stale value is still in the
    URL it was opened with must not override where the client actually got to."""
    chat.get(
        f"/api/v1/chat/sessions/{SESSION_ID}/events?cursor=stale",
        headers={**auth_headers(), "Last-Event-ID": "fresh"},
    )

    _, kwargs = next((name, kw) for name, kw in sessions.calls if name == "stream_events")
    assert kwargs["cursor"] == "fresh"


def test_a_first_attach_sends_no_cursor(chat: TestClient, sessions: FakeSessions) -> None:
    """`None`, not the empty string: the client sends nothing at all when it has no position,
    and forwarding `""` would ask upstream to resume from a cursor that does not exist."""
    chat.get(f"/api/v1/chat/sessions/{SESSION_ID}/events", headers=auth_headers())

    _, kwargs = next((name, kw) for name, kw in sessions.calls if name == "stream_events")
    assert kwargs["cursor"] is None


def test_the_session_a_caller_opens_is_tagged_with_them(chat: TestClient, sessions: FakeSessions) -> None:
    """The tag the whole isolation story rests on, written server-side on the way out."""
    _open(chat, {"type": "text", "text": "hello"})

    _, kwargs = sessions.calls[0]
    assert kwargs["app_context"][OWNER_KEY] == USER_ID


def test_a_caller_cannot_file_its_session_into_somebody_elses_sidebar(chat: TestClient, sessions: FakeSessions) -> None:
    """`app_context` is caller-supplied and free-form, so the owner key has to be stamped over."""
    _open(chat, {"type": "text", "text": "hello"}, app_context={OWNER_KEY: OTHER_USER})

    _, kwargs = sessions.calls[0]
    assert kwargs["app_context"][OWNER_KEY] == USER_ID


@pytest.mark.parametrize(
    ("app_context", "visible"),
    [
        pytest.param(_app_context(), True, id="opened_by_this_caller"),
        pytest.param(_app_context(title="Weekly review"), True, id="titled_and_owned"),
        pytest.param(_app_context(owner=OTHER_USER), False, id="another_app_user"),
        pytest.param({"title": "opened before the tag existed"}, False, id="untagged"),
        pytest.param({}, False, id="empty"),
        pytest.param(None, False, id="absent"),
        pytest.param("not-an-object", False, id="not_an_object"),
    ],
)
def test_the_listing_shows_only_the_sessions_this_caller_opened(
    chat: TestClient, sessions: FakeSessions, app_context: Any, visible: bool
) -> None:
    """With one API key upstream sees one principal for everybody, so this tag is the separation.

    An untagged row counts as somebody else's. The alternative shows a session this mount did not
    open to whichever app user asks for the list first.
    """
    sessions.page = {"items": [_session(app_context=app_context)], "next": None}

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert [item["session_id"] for item in body["items"]] == ([SESSION_ID] if visible else [])


def test_the_listing_hides_sessions_belonging_to_another_agent(chat: TestClient, sessions: FakeSessions) -> None:
    sessions.page = {
        "items": [_session(), _session(agent_name="a-different-agent")],
        "next": None,
    }

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert [item["session_id"] for item in body["items"]] == [SESSION_ID]


def test_the_listing_keeps_asking_until_it_finds_this_callers_sessions(
    chat: TestClient, sessions: FakeSessions
) -> None:
    """The newest rows upstream can all be other people's, and this caller's sit behind them."""
    mine = _session()
    theirs = _session(app_context=_app_context(owner=OTHER_USER))
    sessions.pages = [
        {"items": [theirs, theirs], "next": "cursor-2"},
        {"items": [theirs], "next": "cursor-3"},
        {"items": [mine], "next": "cursor-4"},
    ]

    body = chat.get("/api/v1/chat/sessions?limit=1", headers=auth_headers()).json()

    assert [item["session_id"] for item in body["items"]] == [SESSION_ID]
    assert body["next_cursor"] == "cursor-4"
    assert [kwargs["cursor"] for name, kwargs in sessions.calls if name == "list"] == [None, "cursor-2", "cursor-3"]


def test_the_listing_stops_at_the_end_of_the_upstream_sequence(chat: TestClient, sessions: FakeSessions) -> None:
    sessions.pages = [{"items": [_session(app_context=_app_context(owner=OTHER_USER))], "next": "cursor-2"}]
    sessions.page = {"items": [], "next": None}

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert body == {"items": [], "next_cursor": None}
    assert len([name for name, _ in sessions.calls if name == "list"]) == 2


def test_one_listing_request_cannot_walk_upstream_forever(chat: TestClient, sessions: FakeSessions) -> None:
    """A deployment where nothing on offer is this caller's must not run calls without a bound."""
    sessions.page = {"items": [_session(app_context=_app_context(owner=OTHER_USER))], "next": "cursor-next"}

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert body["items"] == []
    assert len([name for name, _ in sessions.calls if name == "list"]) == 10


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}"),
        ("POST", f"/api/v1/chat/sessions/{SESSION_ID}/commands"),
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}/events"),
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}/events/history"),
        ("POST", f"/api/v1/chat/sessions/{SESSION_ID}/callbacks/{CALLBACK_ID}"),
    ],
)
def test_another_app_users_session_is_unknown_on_every_id_addressed_route(
    chat: TestClient, sessions: FakeSessions, method: str, path: str
) -> None:
    """Knowing the id is not enough: upstream would serve it, because the key is the deployment's."""
    sessions.session = _session(app_context=_app_context(owner=OTHER_USER))

    response = chat.request(method, path, headers=auth_headers(), json=_ANY_BODY)

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown session"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}"),
        ("POST", f"/api/v1/chat/sessions/{SESSION_ID}/commands"),
        ("GET", f"/api/v1/chat/sessions/{SESSION_ID}/events/history"),
        ("POST", f"/api/v1/chat/sessions/{SESSION_ID}/callbacks/{CALLBACK_ID}"),
    ],
)
def test_a_caller_reaches_the_session_it_opened(
    chat: TestClient, sessions: FakeSessions, method: str, path: str
) -> None:
    """The positive half. A filter that refused everything would pass the table above on its own."""
    assert chat.request(method, path, headers=auth_headers(), json=_ANY_BODY).status_code == 200


def test_the_opening_prompt_becomes_the_sessions_title(chat: TestClient, sessions: FakeSessions) -> None:
    """Written upstream rather than stored here, which is the only reason chat still owns no table."""
    _open(chat, {"type": "text", "text": "  How do I   transcribe\naudio?  "})

    _, kwargs = sessions.calls[0]
    assert kwargs["app_context"] == _app_context(title="How do I transcribe audio?")


def test_a_prompt_too_long_for_a_row_is_cut_to_one_bounded_line(chat: TestClient, sessions: FakeSessions) -> None:
    _open(chat, {"type": "text", "text": "transcribe " * 200})

    _, kwargs = sessions.calls[0]
    title = kwargs["app_context"]["title"]
    assert len(title) <= 120
    assert title.endswith("…")


def test_a_caller_that_brought_its_own_title_keeps_it(chat: TestClient, sessions: FakeSessions) -> None:
    _open(chat, {"type": "text", "text": "hello"}, app_context={"title": "Weekly review"})

    _, kwargs = sessions.calls[0]
    assert kwargs["app_context"]["title"] == "Weekly review"


def test_an_opening_turn_with_no_text_is_left_untitled(chat: TestClient, sessions: FakeSessions) -> None:
    """An image-only first turn has no sensible title, and inventing one reads worse than none."""
    _open(chat, {"type": "image", "url": "https://example.test/waveform.png"})

    _, kwargs = sessions.calls[0]
    # The owner tag still rides, or the session would be invisible to the person who just opened it.
    assert kwargs["app_context"] == _app_context()


def test_the_listing_titles_each_row_with_the_prompt_that_opened_it(chat: TestClient, sessions: FakeSessions) -> None:
    sessions.page = {
        "items": [_session(app_context=_app_context(title="How do I transcribe audio?"))],
        "next": None,
    }

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert body["items"][0]["title"] == "How do I transcribe audio?"


def test_a_title_generated_upstream_beats_the_stored_prompt(chat: TestClient, sessions: FakeSessions) -> None:
    """Null today, but this is what makes upstream enabling its generator a no-op here."""
    sessions.page = {
        "items": [
            _session(
                generated_title="Transcribing audio",
                app_context=_app_context(title="How do I transcribe"),
            )
        ],
        "next": None,
    }

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert body["items"][0]["title"] == "Transcribing audio"


@pytest.mark.parametrize(
    "app_context", [_app_context(), _app_context(title=42), _app_context(title="   "), _app_context(title=None)]
)
def test_a_row_with_no_usable_title_is_left_for_the_browser_to_label(
    chat: TestClient, sessions: FakeSessions, app_context: Any
) -> None:
    """`app_context` is free-form, so a row this app opened can still carry no title it can use."""
    sessions.page = {"items": [_session(app_context=app_context)], "next": None}

    body = chat.get("/api/v1/chat/sessions", headers=auth_headers()).json()

    assert body["items"][0]["title"] is None


def test_chat_requires_a_caller(client: TestClient) -> None:
    assert client.get("/api/v1/chat/sessions").status_code == 401


def test_an_unconfigured_deployment_refuses_instead_of_crashing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No caller credential and no key is a missing dependency, not a bug: 503, not 500.

    Worth pinning because the failure is invisible in a configured environment and, left alone,
    puts a stack trace in the log on every poll of the chat sidebar.
    """
    install_caller_credentials(None)
    monkeypatch.setattr(mistral_env, "mistral_api_key", None)

    response = client.get("/api/v1/chat/sessions", headers=auth_headers())

    assert response.status_code == 503
    assert response.json()["detail"] == "Chat is not configured on this deployment"


def _upstream(status_code: int, body: Any) -> httpx.Response:
    request = httpx.Request("GET", "http://upstream")
    if isinstance(body, bytes):
        return httpx.Response(status_code=status_code, content=body, request=request)
    return httpx.Response(status_code=status_code, json=body, request=request)


@pytest.mark.parametrize(
    ("status_code", "body", "expected_status", "expected_detail"),
    [
        (403, {"detail": "forbidden"}, 404, _UNKNOWN),
        (404, {"detail": "no such session"}, 404, _UNKNOWN),
        (500, {"detail": "boom"}, 502, "The agent control plane is unavailable"),
        (503, b"upstream down", 502, "The agent control plane is unavailable"),
        (401, {"detail": "Bad token"}, 401, "Bad token"),
        (401, b"Proxy: invalid or expired space token", 401, _REFUSED),
        (429, b"", 429, _REFUSED),
        (400, {"error": "no detail key"}, 400, _REFUSED),
    ],
    ids=["403", "404", "500", "503-text", "401-json", "401-text", "429-empty", "400-no-detail"],
)
def test_a_refusal_upstream_becomes_the_status_this_app_owes_its_caller(
    status_code: int, body: Any, expected_status: int, expected_detail: str
) -> None:
    """A gateway in front of the control plane refuses in plain text, so an unparseable body is ordinary."""
    with pytest.raises(HTTPException) as refusal:
        _unwrap(_upstream(status_code, body))

    assert (refusal.value.status_code, refusal.value.detail) == (expected_status, expected_detail)


@pytest.mark.parametrize("status_code", [200, 201, 204], ids=["ok", "created", "no-content"])
def test_a_successful_upstream_body_passes_through(status_code: int) -> None:
    """The positive table. A translator that raised on everything would pass the one above."""
    payload = None if status_code == 204 else {"agent_session_id": SESSION_ID}

    assert _unwrap(_upstream(status_code, payload)) == payload


def test_chat_contributes_its_route_surface(client: TestClient) -> None:
    """The chat capability owns the route inventory it adds to the API tree."""
    actual = {
        path: {method for method in item if method in HTTP_METHODS}
        for path, item in client.app.openapi()["paths"].items()
        if path.startswith("/api/v1/chat")
    }

    assert actual == {
        "/api/v1/chat/sessions": {"get", "post"},
        "/api/v1/chat/sessions/{session_id}": {"get"},
        "/api/v1/chat/sessions/{session_id}/commands": {"post"},
        "/api/v1/chat/sessions/{session_id}/events": {"get"},
        "/api/v1/chat/sessions/{session_id}/events/history": {"get"},
        "/api/v1/chat/sessions/{session_id}/callbacks/{callback_id}": {"post"},
        "/api/v1/chat/feedback": {"post"},
    }


def _example_path(path: str) -> str:
    return (
        path.replace("{execution_id}", "exec-1")
        .replace("{session_id}", SESSION_ID)
        .replace("{callback_id}", CALLBACK_ID)
    )


def test_full_composition_json_routes_declare_typed_responses(
    client: TestClient,
) -> None:
    """Feature-owned full-composition guard for the codegen-facing OpenAPI schema."""
    offenders = untyped_json_responses(client.app.openapi())
    assert not offenders, "untyped JSON responses (give the route a concrete return type): " + ", ".join(offenders)


def test_full_composition_serves_the_reflected_schema(client: TestClient) -> None:
    assert client.get("/openapi.json").json() == client.app.openapi()


def test_full_composition_has_no_duplicate_paths(client: TestClient) -> None:
    served = [route.path for route in client.app.routes if isinstance(route, Route | APIRoute)]
    paths = list(client.app.openapi()["paths"]) + served

    duplicates = {path: count for path, count in Counter(paths).items() if count > 1}

    assert duplicates == {}, f"duplicate routes shadow each other: {duplicates}"
    assert any(path.startswith("/api/v1/") for path in paths), "the guard is not seeing contributed API routes"


def test_full_composition_operation_ids_are_unique(client: TestClient) -> None:
    operations = [
        operation["operationId"]
        for methods in client.app.openapi()["paths"].values()
        for method, operation in methods.items()
        if method in HTTP_METHODS and "operationId" in operation
    ]

    duplicates = {name: count for name, count in Counter(operations).items() if count > 1}

    assert duplicates == {}, f"colliding operation ids generate colliding client functions: {duplicates}"
    assert operations, "the guard is not seeing any operations"


def test_full_composition_protected_routes_declare_the_bearer_scheme(
    client: TestClient,
) -> None:
    spec = client.app.openapi()
    schemes = spec.get("components", {}).get("securitySchemes", {})
    assert "HTTPBearer" in schemes, "no bearer security scheme reached the OpenAPI document"
    assert schemes["HTTPBearer"]["bearerFormat"] == "JWT"

    for path, item in spec["paths"].items():
        for method, operation in item.items():
            if method not in HTTP_METHODS or (path.rstrip("/") or "/") in _ANONYMOUS:
                continue
            assert operation.get("security"), f"{method.upper()} {path} does not declare its bearer requirement"


def test_full_composition_routes_outside_internal_refuse_anonymous_callers(
    client: TestClient,
) -> None:
    unprotected = []
    for path, item in client.app.openapi()["paths"].items():
        if (path.rstrip("/") or "/") in _ANONYMOUS:
            continue
        for method in (m for m in item if m in HTTP_METHODS):
            response = client.request(method, _example_path(path))
            if response.status_code != 401:
                unprotected.append(f"{method.upper()} {path} -> {response.status_code}")

    assert unprotected == [], f"reachable without an identity: {unprotected}"
