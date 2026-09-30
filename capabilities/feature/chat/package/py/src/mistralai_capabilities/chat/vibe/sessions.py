"""The control-plane calls ``/chat`` runs on, behind an interface a test can replace.

Named like ``ExecutionStore``: production forwards to the real agents API, a test hands over a
stub, and neither reaches past the other's interface. Reached as a FastAPI dependency, so
``dependency_overrides`` stays the single seam and ``create_app()`` installs nothing.
"""

from collections.abc import AsyncIterator, Mapping
from typing import Annotated, Any, Protocol
from uuid import UUID

import httpx
from fastapi import Depends
from mistralai_capabilities.chat.vibe import client as vibe_agents


class VibeSessions(Protocol):
    async def create(
        self,
        *,
        agent_name: str,
        command: Mapping[str, Any],
        client_session_id: UUID | None,
        app_context: Mapping[str, Any] | None,
    ) -> httpx.Response: ...

    async def get(self, *, session_id: UUID) -> httpx.Response: ...

    async def list(self, *, limit: int, cursor: str | None) -> httpx.Response: ...

    async def submit_command(self, *, session_id: UUID, command: Mapping[str, Any]) -> httpx.Response: ...

    async def submit_callback_result(
        self, *, session_id: UUID, callback_id: UUID, result: Mapping[str, Any]
    ) -> httpx.Response: ...

    async def read_events_history(self, *, session_id: UUID, limit: int, cursor: str | None) -> httpx.Response: ...

    def stream_events(self, *, session_id: UUID, cursor: str | None) -> AsyncIterator[bytes]: ...


class ControlPlaneSessions:
    async def create(
        self,
        *,
        agent_name: str,
        command: Mapping[str, Any],
        client_session_id: UUID | None,
        app_context: Mapping[str, Any] | None,
    ) -> httpx.Response:
        return await vibe_agents.create_session_with_command(
            agent_name=agent_name,
            command=dict(command),
            client_session_id=client_session_id,
            app_context=dict(app_context) if app_context is not None else None,
        )

    async def get(self, *, session_id: UUID) -> httpx.Response:
        return await vibe_agents.get_session(session_id=session_id)

    async def list(self, *, limit: int, cursor: str | None) -> httpx.Response:
        return await vibe_agents.list_sessions(limit=limit, cursor=cursor)

    async def submit_command(self, *, session_id: UUID, command: Mapping[str, Any]) -> httpx.Response:
        return await vibe_agents.submit_command(session_id=session_id, command=dict(command))

    async def submit_callback_result(
        self, *, session_id: UUID, callback_id: UUID, result: Mapping[str, Any]
    ) -> httpx.Response:
        return await vibe_agents.submit_callback_result(
            session_id=session_id, callback_id=callback_id, result=dict(result)
        )

    async def read_events_history(self, *, session_id: UUID, limit: int, cursor: str | None) -> httpx.Response:
        return await vibe_agents.read_events_history(session_id=session_id, limit=limit, cursor=cursor)

    def stream_events(self, *, session_id: UUID, cursor: str | None) -> AsyncIterator[bytes]:
        return vibe_agents.stream_session_events(session_id=session_id, cursor=cursor)


# One instance, not one per request: the adapter holds no state, opening its connection per call.
_CONTROL_PLANE = ControlPlaneSessions()


def _sessions() -> VibeSessions:
    return _CONTROL_PLANE


Sessions = Annotated[VibeSessions, Depends(_sessions)]
