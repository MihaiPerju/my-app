"""One control-plane agent in, the session surface a chat client needs out.

``VibeAgentsRouter`` fronts a vibe_agents session. It re-checks ``agent`` and the app user who
opened the session, answering 404 for either, because upstream scopes by neither. On streaming
routes the check resolves before the response starts. Each endpoint sets ``__name__`` so
``url_path_for`` stays unambiguous per agent.
"""

from collections.abc import AsyncIterator, Sequence
from json import JSONDecodeError
from typing import Annotated, Any
from uuid import UUID

import httpx
from env.vibe_agents import env
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from mistralai_capabilities.chat.vibe.client import VibeAgentsNotConfiguredError, decode
from mistralai_capabilities.chat.vibe.identity import ChatCaller
from mistralai_capabilities.chat.vibe.schemas import (
    CallbackAccepted,
    CallbackResultRequest,
    ChatSession,
    ChatSessionPage,
    CommandAccepted,
    CreateSessionRequest,
    EventsHistory,
    MessageCommand,
    Session,
    SessionCommand,
    StartedSession,
    StreamError,
    app_context_for,
    owned_by,
)
from mistralai_capabilities.chat.vibe.sessions import Sessions, VibeSessions
from mistralai_capabilities.fastapi.sse import event_stream_response, format_sse

_NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"description": "Unknown session"}}
_SSE: dict[int | str, dict[str, Any]] = {200: {"content": {"text/event-stream": {}}}, **_NOT_FOUND}

# The phrase every refusal here uses, deliberately identical. A message that distinguished
# "no such session" from "not yours" from "wrong agent" would be the existence oracle the
# 404-not-403 convention exists to deny (D3).
_UNKNOWN = "Unknown session"

_REFUSED = "The agent control plane refused the request"

# How many upstream pages one listing request may walk. Without it a deployment whose sessions
# mostly belong to other people turns a single browser request into an open-ended run of calls.
_MAX_UPSTREAM_PAGES = 10


def _unwrap(response: httpx.Response) -> Any:
    """The upstream body, or the refusal its status calls for.

    Statuses are translated. 403 becomes 404 so a caller cannot learn their id named something real.
    5xx becomes 502 because a control-plane fault is this app's upstream failing.
    """
    if response.is_success:
        return decode(response)
    if response.status_code in (403, 404):
        raise HTTPException(status_code=404, detail=_UNKNOWN)
    if response.status_code >= 500:
        raise HTTPException(status_code=502, detail="The agent control plane is unavailable")
    raise HTTPException(status_code=response.status_code, detail=_detail(response))


def _detail(response: httpx.Response) -> str:
    # A refusal can come from anything between here and the control plane, and a gateway in the
    # way answers in plain text rather than JSON, so a body that will not parse is ordinary.
    try:
        body = decode(response)
    except (JSONDecodeError, UnicodeDecodeError):
        return _REFUSED
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        return body["detail"]
    return _REFUSED


def _outbound(command: Any, *, conversation_id: str | None = None) -> dict[str, Any]:
    """A validated command, with the attribution and observability the control plane requires.

    ``source`` is stamped here so a browser cannot disguise its requests as another's.
    ``metadata.observability`` controls tracing and rides only on a turn. ``conversation_id`` is the
    upstream session id, ``None`` on the create that opens the session.
    """
    outbound = {**command.model_dump(mode="json"), "source": env.vibe_agents_application_name}
    if not isinstance(command, MessageCommand):
        return outbound

    observability: dict[str, Any] = {"dora_tracing_enabled": True}
    if conversation_id is not None:
        observability["conversation_id"] = conversation_id

    metadata = outbound.get("metadata")
    outbound["metadata"] = (
        {**metadata, "observability": observability} if isinstance(metadata, dict) else {"observability": observability}
    )
    return outbound


async def _owned_session(sessions: VibeSessions, caller: str, session_id: UUID, agent: str) -> dict[str, Any]:
    """The session, if this caller opened it AND it belongs to this mount's agent."""
    session = _unwrap(await sessions.get(session_id=session_id))
    if not isinstance(session, dict) or session.get("agent_name") != agent or not owned_by(session, caller):
        raise HTTPException(status_code=404, detail=_UNKNOWN)
    return session


def VibeAgentsRouter(
    *,
    agent: str,
    name: str,
    prefix: str = "",
    tags: Sequence[str] = (),
) -> APIRouter:
    """The session surface for one control-plane ``agent``, as a mountable router.

    ``agent`` is what this mount fronts and the discriminator every id-addressed route re-checks.
    ``name`` is the operation-id namespace only, unlike ``WorkflowRouter``'s.
    """
    router = APIRouter(prefix=prefix, tags=list(tags))

    def mount(operation: str, method: str, path: str, endpoint: Any, **options: Any) -> None:
        operation_id = f"{name}_{operation}"
        endpoint.__name__ = operation_id
        router.add_api_route(path, endpoint, methods=[method], name=operation_id, operation_id=operation_id, **options)

    async def create_session(body: CreateSessionRequest, sessions: Sessions, caller: ChatCaller) -> StartedSession:
        started = _unwrap(
            await sessions.create(
                agent_name=agent,
                command=_outbound(body.initial_command),
                client_session_id=body.client_session_id,
                app_context=app_context_for(body.app_context, body.initial_command.message, owner=caller),
            )
        )
        return StartedSession.model_validate(started)

    mount(
        "create_session",
        "POST",
        "/sessions",
        create_session,
        status_code=201,
        response_model=StartedSession,
        summary="Open a chat session",
    )

    async def list_sessions(
        sessions: Sessions,
        caller: ChatCaller,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        cursor: str | None = None,
    ) -> ChatSessionPage:
        # Upstream can filter by neither the agent nor the app user, so one API key means a page
        # can be entirely other people's rows. Keep asking for the next one until enough of this
        # caller's sessions have turned up or upstream runs out. Returning the first page filtered
        # would show an empty list to anyone whose sessions sit further down the sequence.
        mine: list[ChatSession] = []
        next_cursor = cursor
        for _ in range(_MAX_UPSTREAM_PAGES):
            page = _unwrap(await sessions.list(limit=limit, cursor=next_cursor))
            page = page if isinstance(page, dict) else {}
            mine.extend(
                ChatSession.from_upstream(item)
                for item in page.get("items") or []
                if item.get("agent_name") == agent and owned_by(item, caller)
            )
            next_cursor = page.get("next")
            if next_cursor is None or len(mine) >= limit:
                break
        # The cursor moves a whole upstream page at a time, so the last page fetched can carry a
        # few rows past `limit`. They are returned rather than dropped, because `next_cursor`
        # already points beyond them and nothing would fetch them again.
        return ChatSessionPage(items=mine, next_cursor=next_cursor)

    mount(
        "list_sessions",
        "GET",
        "/sessions",
        list_sessions,
        response_model=ChatSessionPage,
        summary="List this caller's chat sessions",
    )

    async def get_session(session_id: UUID, sessions: Sessions, caller: ChatCaller) -> Session:
        return Session.model_validate(await _owned_session(sessions, caller, session_id, agent))

    mount(
        "get_session",
        "GET",
        "/sessions/{session_id}",
        get_session,
        response_model=Session,
        responses=_NOT_FOUND,
        summary="Read one chat session",
    )

    async def submit_command(
        session_id: UUID, body: SessionCommand, sessions: Sessions, caller: ChatCaller
    ) -> CommandAccepted:
        await _owned_session(sessions, caller, session_id, agent)
        accepted = _unwrap(
            await sessions.submit_command(
                session_id=session_id,
                command=_outbound(body, conversation_id=str(session_id)),
            )
        )
        return CommandAccepted.model_validate(accepted)

    mount(
        "submit_command",
        "POST",
        "/sessions/{session_id}/commands",
        submit_command,
        response_model=CommandAccepted,
        responses=_NOT_FOUND,
        summary="Send a turn, or stop one",
    )

    async def events_history(
        session_id: UUID,
        sessions: Sessions,
        caller: ChatCaller,
        limit: Annotated[int, Query(ge=1, le=5000)] = 500,
        cursor: str | None = None,
    ) -> EventsHistory:
        await _owned_session(sessions, caller, session_id, agent)
        history = _unwrap(await sessions.read_events_history(session_id=session_id, limit=limit, cursor=cursor))
        return EventsHistory.model_validate(history)

    mount(
        "events_history",
        "GET",
        "/sessions/{session_id}/events/history",
        events_history,
        response_model=EventsHistory,
        response_model_by_alias=True,
        responses=_NOT_FOUND,
        summary="Replay a session's committed events",
    )

    async def events_stream(
        session_id: UUID,
        sessions: Sessions,
        caller: ChatCaller,
        cursor: str | None = None,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> StreamingResponse:
        # Read from the header first: `Last-Event-ID` is the standard resume field that an SSE
        # client sends on reconnect. Accepting only the query parameter discarded every resume, so
        # the stream replayed from the start and history `add` patches duplicated every message.
        resume = last_event_id or cursor
        # Awaited here, not inside the generator: once the response is constructed the status
        # line is committed and a refusal can no longer be a 404.
        await _owned_session(sessions, caller, session_id, agent)
        return event_stream_response(_passthrough(sessions.stream_events(session_id=session_id, cursor=resume)))

    mount(
        "events_stream",
        "GET",
        "/sessions/{session_id}/events",
        events_stream,
        response_class=StreamingResponse,
        response_model=None,
        responses=_SSE,
        summary="Follow a session's events",
    )

    async def submit_callback(
        session_id: UUID,
        callback_id: UUID,
        body: CallbackResultRequest,
        sessions: Sessions,
        caller: ChatCaller,
    ) -> CallbackAccepted:
        await _owned_session(sessions, caller, session_id, agent)
        accepted = _unwrap(
            await sessions.submit_callback_result(session_id=session_id, callback_id=callback_id, result=body.result)
        )
        return CallbackAccepted.model_validate(accepted)

    mount(
        "submit_callback",
        "POST",
        "/sessions/{session_id}/callbacks/{callback_id}",
        submit_callback,
        response_model=CallbackAccepted,
        responses=_NOT_FOUND,
        summary="Answer a question the agent asked",
    )

    return router


async def _passthrough(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """The control plane's own SSE bytes, forwarded without being re-framed.

    Not parsed and re-encoded, because the browser validates the vendor frame and any encoding
    difference is a bug it sees and this app cannot. The heartbeat comments ride through too, because
    they hold an idle turn open.
    """
    try:
        async for chunk in chunks:
            yield chunk.decode("utf-8", errors="replace")
    except (httpx.HTTPError, VibeAgentsNotConfiguredError) as error:
        # The status line is long gone, so a failure can only be reported inside the stream.
        # The class name, never the message: an upstream error string can carry a URL or a
        # header, and this frame is rendered in a browser.
        yield format_sse(event="error", data=StreamError(message=type(error).__name__))
