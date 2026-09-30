"""Test doubles for the collaborators a ``WorkflowRouter`` route declares.

These doubles are shared, not local to one module, so they do not drift from the
``ExecutionCommands`` Protocol. Each canned answer is a real SDK model, because the router mostly
maps from those models. A hand-rolled answer would pass while the mapper was wrong.
"""

from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from typing import Any, Literal

from db.models.user import User
from mistralai_capabilities.workflows import client as workflows_client

STARTED_AT = datetime(2024, 1, 1, tzinfo=UTC)


def user(user_id: str = "caller-1", email: str = "dev@mistral.ai") -> User:
    return User(user_id=user_id, email=email, is_active=True)


class FakeExecutionStore:
    """The ownership table as a set of the triple it is keyed on, plus the idempotency reservations."""

    def __init__(self, owned: set[tuple[str, str, str]] | None = None) -> None:
        self.owned = owned or set()
        self.reservations: dict[tuple[str, str, str], str] = {}
        # Recording order stands in for `created_at`; this fake has no clock. The accessor pages
        # newest first, so `list_owned` walks this in reverse. Pre-seeded rows are sorted so a
        # listing assertion does not depend on set iteration order.
        self.recorded: list[str] = sorted(execution_id for execution_id, _, _ in self.owned)
        self.list_calls: list[dict[str, Any]] = []
        # Outcomes are keyed by `(execution_id, user_id)`, matching the accessor scope: the write
        # is bounded by the owner, not the ownership triple.
        self.outcomes_by_owner: dict[tuple[str, str], str] = {}

    async def record(self, *, execution_id: str, user_id: str, workflow_name: str) -> None:
        self.owned.add((execution_id, user_id, workflow_name))
        self.recorded.append(execution_id)

    async def is_owned_by(self, *, execution_id: str, user_id: str, workflow_name: str) -> bool:
        return (execution_id, user_id, workflow_name) in self.owned

    async def owned_ids(self, *, execution_ids: Sequence[str], user_id: str, workflow_name: str) -> set[str]:
        return {execution_id for execution_id in execution_ids if (execution_id, user_id, workflow_name) in self.owned}

    async def list_owned(
        self,
        *,
        user_id: str,
        workflow_name: str,
        limit: int,
        after_id: str | None = None,
        created_after: datetime | None = None,
        created_before: datetime | None = None,
    ) -> list[str]:
        self.list_calls.append(
            {
                "user_id": user_id,
                "workflow_name": workflow_name,
                "limit": limit,
                "after_id": after_id,
                "created_after": created_after,
                "created_before": created_before,
            }
        )
        mine = [
            execution_id
            for execution_id in reversed(self.recorded)
            if (execution_id, user_id, workflow_name) in self.owned
        ]
        if after_id is not None:
            # A cursor the caller does not own pages nothing, like the NULL row comparison in the
            # accessor. A foreign cursor must look the same as an exhausted one.
            if after_id not in mine:
                return []
            mine = mine[mine.index(after_id) + 1 :]
        return mine[:limit]

    async def reserve_execution(
        self, *, execution_id: str, user_id: str, workflow_name: str, idempotency_key: str
    ) -> str:
        # `setdefault` is the in-memory stand-in for the accessor atomic INSERT ... ON CONFLICT.
        # The first caller of a key wins, and every later caller of that key gets its id.
        winner = self.reservations.setdefault((user_id, workflow_name, idempotency_key), execution_id)
        if (winner, user_id, workflow_name) not in self.owned:
            self.owned.add((winner, user_id, workflow_name))
            self.recorded.append(winner)
        return winner

    async def discard(self, *, execution_id: str, user_id: str, workflow_name: str) -> None:
        self.owned.discard((execution_id, user_id, workflow_name))
        # The row carries the key, so dropping the row frees the key. This compensation makes a
        # failed idempotent create retryable.
        self.reservations = {key: won for key, won in self.reservations.items() if won != execution_id}
        if execution_id in self.recorded:
            self.recorded.remove(execution_id)

    async def set_outcome(self, *, execution_id: str, user_id: str, outcome: str) -> bool:
        # First writer wins, bounded to the caller row. This is the in-memory stand-in for the
        # accessor `UPDATE … WHERE outcome IS NULL AND user_id = …`.
        if (execution_id, user_id) in self.outcomes_by_owner:
            return False
        self.outcomes_by_owner[(execution_id, user_id)] = outcome
        return True

    async def outcomes(self, *, execution_ids: Sequence[str], user_id: str) -> dict[str, str]:
        return {
            execution_id: self.outcomes_by_owner[(execution_id, user_id)]
            for execution_id in execution_ids
            if (execution_id, user_id) in self.outcomes_by_owner
        }


class FakeStart:
    """Start a workflow, and honour a caller-supplied id like the real client does.

    ``start_workflow`` raises when the platform returns an id other than the requested one. A fake
    that ignored the argument would hide a router that recorded ownership under one id but started
    another.
    """

    def __init__(self, execution_id: str = "exec-1", result: Any = None) -> None:
        self.execution_id = execution_id
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def __call__(
        self,
        workflow_class: type,
        workflow_input: Any,
        *,
        wait_for_result: bool,
        timeout_seconds: float | None = None,
        execution_id: str | None = None,
    ) -> workflows_client.WorkflowRun:
        self.calls.append(
            {
                "workflow_class": workflow_class,
                "input": workflow_input,
                "wait_for_result": wait_for_result,
                "execution_id": execution_id,
            }
        )
        return workflows_client.WorkflowRun(execution_id=execution_id or self.execution_id, result=self.result)


class FakeStream:
    def __init__(self, frames: list[Any] | None = None) -> None:
        self.frames = frames if frames is not None else [{"event": "completed", "data": {"text": "hi"}}]
        self.seen: list[str] = []
        self.event_sources: list[str | None] = []
        self.last_event_ids: list[str | None] = []

    def __call__(
        self,
        execution_id: str,
        *,
        event_source: workflows_client.EventSource | None = None,
        last_event_id: str | None = None,
    ) -> AsyncIterator[Any]:
        self.seen.append(execution_id)
        self.event_sources.append(event_source)
        self.last_event_ids.append(last_event_id)
        return self._frames()

    async def _frames(self) -> AsyncIterator[Any]:
        for frame in self.frames:
            yield frame


class FakeCancel:
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    async def __call__(self, execution_id: str) -> None:
        self.cancelled.append(execution_id)


def _execution(execution_id: str = "exec-1") -> workflows_client.WorkflowExecutionResponse:
    return workflows_client.WorkflowExecutionResponse(
        workflow_name="demo",
        execution_id=execution_id,
        root_execution_id=execution_id,
        status="COMPLETED",
        start_time=STARTED_AT,
        end_time=None,
        result={"text": "hi"},
    )


class FakeExecutionCommands:
    """Every ``ExecutionCommands`` operation, recorded and answered with a canned SDK response."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.log_frames: list[Any] = [{"body": "line one"}]

    @property
    def operations(self) -> list[str]:
        return [operation for operation, _ in self.calls]

    def _record(self, operation: str, **fields: Any) -> None:
        self.calls.append((operation, fields))

    async def get_execution(self, execution_id: str) -> workflows_client.WorkflowExecutionResponse:
        self._record("get_execution", execution_id=execution_id)
        return _execution(execution_id)

    async def get_execution_history(
        self, execution_id: str, *, decode_payloads: bool | None = None
    ) -> workflows_client.WorkflowExecutionHistory:
        self._record("get_execution_history", execution_id=execution_id, decode_payloads=decode_payloads)
        return {"events": [{"id": 1}]}

    async def terminate_execution(self, execution_id: str) -> None:
        self._record("terminate_execution", execution_id=execution_id)

    async def batch_cancel_executions(self, execution_ids: list[str]) -> workflows_client.BatchExecutionResponse:
        self._record("batch_cancel_executions", execution_ids=execution_ids)
        return _batch(execution_ids)

    async def batch_terminate_executions(self, execution_ids: list[str]) -> workflows_client.BatchExecutionResponse:
        self._record("batch_terminate_executions", execution_ids=execution_ids)
        return _batch(execution_ids)

    async def signal_execution(
        self, execution_id: str, *, name: str, input: Any = None
    ) -> workflows_client.SignalWorkflowResponse:
        self._record("signal_execution", execution_id=execution_id, name=name, input=input)
        return workflows_client.SignalWorkflowResponse(message="signalled")

    async def query_execution(
        self, execution_id: str, *, name: str, input: Any = None
    ) -> workflows_client.QueryWorkflowResponse:
        self._record("query_execution", execution_id=execution_id, name=name, input=input)
        return workflows_client.QueryWorkflowResponse(query_name=name, result={"answered": True})

    async def update_execution(
        self, execution_id: str, *, name: str, input: Any = None
    ) -> workflows_client.UpdateWorkflowResponse:
        self._record("update_execution", execution_id=execution_id, name=name, input=input)
        return workflows_client.UpdateWorkflowResponse(update_name=name, result={"applied": True})

    async def reset_execution(
        self,
        execution_id: str,
        *,
        event_id: int,
        reason: str | None = None,
        exclude_signals: bool = False,
        exclude_updates: bool = False,
    ) -> None:
        self._record(
            "reset_execution",
            execution_id=execution_id,
            event_id=event_id,
            reason=reason,
            exclude_signals=exclude_signals,
            exclude_updates=exclude_updates,
        )

    async def get_execution_logs(
        self,
        execution_id: str,
        *,
        run_id: str | None = None,
        activity_id: str | None = None,
        after: datetime | None = None,
        before: datetime | None = None,
        order: Literal["asc", "desc"] | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> workflows_client.ExecutionLogSearchResponse:
        self._record("get_execution_logs", execution_id=execution_id, run_id=run_id, limit=limit)
        # Built through the envelope rather than by naming the record class: `mistralai_capabilities.workflows.client`
        # re-exports only the top-level responses, and this package does not import `mistralai`.
        return workflows_client.ExecutionLogSearchResponse.model_validate(
            {
                "results": [
                    {
                        "timestamp": STARTED_AT,
                        "trace_id": "trace-1",
                        "span_id": "span-1",
                        "severity_text": "INFO",
                        "body": "line one",
                        "log_attributes": {"activity": "demo"},
                    }
                ]
            }
        )

    def stream_execution_logs(
        self,
        execution_id: str,
        *,
        run_id: str | None = None,
        activity_id: str | None = None,
        after: datetime | None = None,
        last_event_id: str | None = None,
    ) -> AsyncIterator[Any]:
        self._record("stream_execution_logs", execution_id=execution_id, run_id=run_id)
        return self._log_lines()

    async def _log_lines(self) -> AsyncIterator[Any]:
        for frame in self.log_frames:
            yield frame

    async def get_execution_trace_info(self, execution_id: str) -> workflows_client.ExecutionTraceInfoResponse:
        self._record("get_execution_trace_info", execution_id=execution_id)
        return workflows_client.ExecutionTraceInfoResponse(otel_trace_id="otel-1", has_trace_data=True)

    async def get_execution_trace_otel(self, execution_id: str) -> workflows_client.WorkflowExecutionTraceOTelResponse:
        self._record("get_execution_trace_otel", execution_id=execution_id)
        return workflows_client.WorkflowExecutionTraceOTelResponse(
            **_envelope(execution_id), data_source="tempo", otel_trace_id="otel-1"
        )

    async def get_execution_trace_summary(
        self, execution_id: str
    ) -> workflows_client.WorkflowExecutionTraceSummaryResponse:
        self._record("get_execution_trace_summary", execution_id=execution_id)
        return workflows_client.WorkflowExecutionTraceSummaryResponse(**_envelope(execution_id))

    async def get_execution_trace_events(
        self, execution_id: str, *, merge_same_id_events: bool = False, include_internal_events: bool = False
    ) -> workflows_client.WorkflowExecutionTraceEventsResponse:
        self._record(
            "get_execution_trace_events",
            execution_id=execution_id,
            merge_same_id_events=merge_same_id_events,
            include_internal_events=include_internal_events,
        )
        return workflows_client.WorkflowExecutionTraceEventsResponse(**_envelope(execution_id), events=[])


def _batch(execution_ids: list[str]) -> workflows_client.BatchExecutionResponse:
    return workflows_client.BatchExecutionResponse.model_validate(
        {"results": {execution_id: {"status": "accepted"} for execution_id in execution_ids}}
    )


def _envelope(execution_id: str) -> dict[str, Any]:
    return {
        "workflow_name": "demo",
        "execution_id": execution_id,
        "root_execution_id": execution_id,
        "status": "COMPLETED",
        "start_time": STARTED_AT,
        "end_time": None,
        "result": None,
    }
