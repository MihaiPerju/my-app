"""The wire models for ``/chat``, in the two shapes this surface needs.

Response envelopes are permissive (``extra="allow"``, D29) so unanticipated vendor fields pass
through; ``ChatSessionPage`` is the app-owned exception, because the SDK has no list operation.
Request models are strict: they declare only what a caller may say and drop the rest.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

_PASSTHROUGH = ConfigDict(extra="allow")


class MessageInput(BaseModel):
    """The user's turn. ``parts`` stays open so image and file parts need no change here."""

    model_config = _PASSTHROUGH

    role: Literal["user"] = "user"
    parts: list[dict[str, Any]]


class MessageCommand(BaseModel):
    # `extra` is NOT allowed: this model is the allowlist. Anything a caller adds beyond these
    # fields is dropped before the body reaches the control plane, which is what stops a browser
    # granting itself toolsets or skills through a field this app never meant to expose.
    model_config = ConfigDict(extra="ignore")

    type: Literal["message"] = "message"
    command_id: UUID
    message: MessageInput


class CancelCommand(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["cancel_session"]
    command_id: UUID
    reason: str = "cancelled by the caller"


class InterruptCommand(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["interrupt_session"]
    command_id: UUID
    reason: str = "interrupted by the caller"


# `update_agent_configuration` is deliberately absent. It is a real upstream command, but it
# rewrites the session's toolsets — a privilege decision that belongs to this app's deployment
# config, never to whoever is typing in the chat box.
SessionCommand = Annotated[
    MessageCommand | CancelCommand | InterruptCommand,
    Field(discriminator="type"),
]


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    initial_command: MessageCommand
    client_session_id: UUID | None = None
    app_context: dict[str, Any] | None = None


class CallbackResultRequest(BaseModel):
    model_config = _PASSTHROUGH

    result: dict[str, Any]


class Session(BaseModel):
    model_config = _PASSTHROUGH

    agent_session_id: str
    agent_name: str
    status: str


class StartedSession(BaseModel):
    model_config = _PASSTHROUGH

    agent_session: Session


class ObservedEvent(BaseModel):
    model_config = _PASSTHROUGH

    sequence: str
    event: dict[str, Any]


class EventsHistory(BaseModel):
    model_config = _PASSTHROUGH

    events: list[ObservedEvent]
    # The upstream field is camelCase on the wire and the browser SDK parses it by that name, so
    # the alias is the contract; the snake_case attribute is only how Python spells it.
    next_cursor: str | None = Field(default=None, alias="nextCursor")


class CommandAccepted(BaseModel):
    model_config = _PASSTHROUGH

    agent_session_id: str
    command_id: str


class CallbackAccepted(BaseModel):
    model_config = _PASSTHROUGH

    agent_session_id: str
    callback_id: str


# A session's title, written on create and read back on list. Upstream declares `generated_title`
# and ships a generator for it, but that generator is disabled by default, so the field comes back
# null and every row reads "Untitled chat". `app_context` is the way out: a free-form object the
# control plane stores and returns verbatim on create, list, and get, so a title can live there
# without this app persisting anything about chat (D29). The generated title still wins when present.
_TITLE_KEY = "title"
_TITLE_MAX_CHARS = 120


def _clamp(title: str) -> str | None:
    """One line, bounded. Whitespace is collapsed so a pasted multi-line prompt stays one row."""
    collapsed = " ".join(title.split())
    if not collapsed:
        return None
    if len(collapsed) <= _TITLE_MAX_CHARS:
        return collapsed
    return collapsed[: _TITLE_MAX_CHARS - 1].rstrip() + "…"


def title_from_message(message: MessageInput) -> str | None:
    """The first prompt, as the session's title.

    Only text parts are read: an opening turn that is nothing but an image has no sensible title,
    and `None` leaves the row to the browser's own "Untitled chat" rather than inventing one.
    """
    return _clamp(
        " ".join(
            part["text"] for part in message.parts if part.get("type") == "text" and isinstance(part.get("text"), str)
        )
    )


def _with_title(app_context: dict[str, Any] | None, message: MessageInput) -> dict[str, Any] | None:
    """``app_context``, carrying a title derived from the opening prompt.

    Derived here, not in the browser, because it then holds for every caller, and because the SDK
    captures its ``appContext`` closure before the first prompt. A caller's own title is kept.
    """
    if isinstance(app_context, dict) and isinstance(app_context.get(_TITLE_KEY), str):
        return app_context
    title = title_from_message(message)
    if title is None:
        return app_context
    return {**(app_context or {}), _TITLE_KEY: title}


# Which app user the session belongs to. On a deployment with one API key the agents API sees a
# single principal for everybody, so without this every person's chats would list for every other
# person. Unlike the title, a caller cannot supply it: a browser that could would file its session
# into somebody else's sidebar.
_OWNER_KEY = "owner_user_id"


def app_context_for(app_context: dict[str, Any] | None, message: MessageInput, *, owner: str) -> dict[str, Any]:
    return {**(_with_title(app_context, message) or {}), _OWNER_KEY: owner}


def owned_by(session: dict[str, Any], owner: str) -> bool:
    """Whether ``owner`` opened this session through this mount.

    A session the mount did not open carries no owner and is treated as somebody else's, which is
    the safe way round: the alternative shows an untagged session to whoever asks first.
    """
    app_context = session.get("app_context")
    return isinstance(app_context, dict) and app_context.get(_OWNER_KEY) == owner


def _title_from_app_context(app_context: Any) -> str | None:
    """The title this app wrote, re-clamped because `app_context` is free-form and unvalidated."""
    if not isinstance(app_context, dict):
        return None
    title = app_context.get(_TITLE_KEY)
    return _clamp(title) if isinstance(title, str) else None


class ChatSession(BaseModel):
    """One row of the conversation list, as this app chooses to present it."""

    session_id: str
    status: str
    title: str | None = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_upstream(cls, session: dict[str, Any]) -> ChatSession:
        generated = session.get("generated_title")
        upstream_title = _clamp(generated) if isinstance(generated, str) else None
        return cls(
            session_id=str(session["agent_session_id"]),
            status=str(session["status"]),
            title=upstream_title or _title_from_app_context(session.get("app_context")),
            created_at=session["created_at"],
            updated_at=session["updated_at"],
        )


class ChatSessionPage(BaseModel):
    items: list[ChatSession]
    next_cursor: str | None = None


class ChatFeedbackRequest(BaseModel):
    """A rating on one assistant answer.

    ``trace_id`` / ``span_id`` are optional and deliberately not invented when absent. Studio
    stores a rating as a *span* evaluation, so supplying them pins it to the span it judges — but
    a fabricated id would point at a trace that does not exist, which reads worse than an empty
    one. Absent them, the rating is still queryable: ``conversation_id`` is a first-class column
    on both traces and span evaluations, and it is the session id.
    """

    model_config = ConfigDict(extra="ignore")

    session_id: str = Field(max_length=255)
    # The SDK's id for the rated bubble. Server-issued for a user turn and positional
    # (`message-<n>`) for an assistant one, because the control plane leaves assistant entries
    # unidentified — so it addresses a message within a session, and is meaningless without one.
    message_id: str = Field(max_length=255)
    rating: Literal["up", "down"]
    trace_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    span_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{16}$")


class StreamError(BaseModel):
    """The last frame of a stream that broke after its status line was already sent.

    Declared here rather than reused from the execution surface: the two streams share a spelling
    and nothing else, and borrowing the model would tie this contract to changes made for the
    other one.
    """

    message: str
