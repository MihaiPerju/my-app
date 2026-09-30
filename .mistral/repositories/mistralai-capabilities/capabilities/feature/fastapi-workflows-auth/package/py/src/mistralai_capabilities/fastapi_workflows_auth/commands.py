"""Driving a workflow, as dependencies a route can declare and a test can replace.

Plain functions from ``mistralai_capabilities.workflows.client`` behind FastAPI dependencies. The seam is
``dependency_overrides``, so each dependency returns the callable instead of calling it. ``Start``
begins a workflow; ``Stream`` and ``Cancel`` are the lifecycle verbs; everything else addresses an
existing execution through the ``Commands`` facade (see :class:`ExecutionCommands`).
"""

import asyncio
import random
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from datetime import datetime
from typing import Annotated, Any, Literal, Protocol, TypeVar

from fastapi import Depends
from pydantic import BaseModel
from mistralai_capabilities.workflows import client as workflows_client
from mistralai_capabilities.workflows.client import MistralError


# A Protocol, not a ``Callable[...]`` alias, because the signature is keyword-only from
# ``wait_for_result`` on, which ``Callable`` cannot express.
class StartWorkflow(Protocol):
    async def __call__(
        self,
        workflow_class: type,
        workflow_input: BaseModel,
        *,
        wait_for_result: bool,
        timeout_seconds: float | None = None,
        execution_id: str | None = None,
    ) -> workflows_client.WorkflowRun: ...


# A Protocol, not an alias, for the same reason as ``StartWorkflow``: the interesting argument is
# keyword-only. ``event_source`` decides whether a consumer that attaches after the start sees what
# it missed, so dropping it would make replay unreachable.
class StreamExecution(Protocol):
    def __call__(
        self,
        execution_id: str,
        *,
        event_source: workflows_client.EventSource | None = None,
        last_event_id: str | None = None,
    ) -> AsyncIterator[Any]: ...


CancelExecution = Callable[[str], Awaitable[None]]


def _start() -> StartWorkflow:
    return workflows_client.start_workflow


def _stream() -> StreamExecution:
    return workflows_client.stream_execution


def _cancel() -> CancelExecution:
    return workflows_client.cancel_execution


Start = Annotated[StartWorkflow, Depends(_start)]
Stream = Annotated[StreamExecution, Depends(_stream)]
Cancel = Annotated[CancelExecution, Depends(_cancel)]


# One facade rather than fifteen more aliases: a test faking the collaborator would otherwise need
# fifteen ``dependency_overrides`` entries. Named for what the operations share: each addresses an
# execution that already exists, where ``Start`` brings one into being.
class ExecutionCommands(Protocol):
    async def get_execution(self, execution_id: str) -> workflows_client.WorkflowExecutionResponse: ...

    async def get_execution_history(
        self,
        execution_id: str,
        *,
        decode_payloads: bool | None = None,
    ) -> workflows_client.WorkflowExecutionHistory: ...

    async def terminate_execution(self, execution_id: str) -> None: ...

    async def batch_cancel_executions(self, execution_ids: list[str]) -> workflows_client.BatchExecutionResponse: ...

    async def batch_terminate_executions(self, execution_ids: list[str]) -> workflows_client.BatchExecutionResponse: ...

    async def signal_execution(
        self,
        execution_id: str,
        *,
        name: str,
        input: workflows_client.SignalInvocationBodyInput | None = None,
    ) -> workflows_client.SignalWorkflowResponse: ...

    async def query_execution(
        self,
        execution_id: str,
        *,
        name: str,
        input: workflows_client.QueryInvocationBodyInput | None = None,
    ) -> workflows_client.QueryWorkflowResponse: ...

    async def update_execution(
        self,
        execution_id: str,
        *,
        name: str,
        input: workflows_client.UpdateInvocationBodyInput | None = None,
    ) -> workflows_client.UpdateWorkflowResponse: ...

    async def reset_execution(
        self,
        execution_id: str,
        *,
        event_id: int,
        reason: str | None = None,
        exclude_signals: bool = False,
        exclude_updates: bool = False,
    ) -> None: ...

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
    ) -> workflows_client.ExecutionLogSearchResponse: ...

    # Not `async def`: an async generator function returns its iterator directly rather than a
    # coroutine, which is the same reason `StreamExecution` above is a plain `Callable`.
    def stream_execution_logs(
        self,
        execution_id: str,
        *,
        run_id: str | None = None,
        activity_id: str | None = None,
        after: datetime | None = None,
        last_event_id: str | None = None,
    ) -> AsyncIterator[Any]: ...

    async def get_execution_trace_info(self, execution_id: str) -> workflows_client.ExecutionTraceInfoResponse: ...

    async def get_execution_trace_otel(
        self, execution_id: str
    ) -> workflows_client.WorkflowExecutionTraceOTelResponse: ...

    async def get_execution_trace_summary(
        self, execution_id: str
    ) -> workflows_client.WorkflowExecutionTraceSummaryResponse: ...

    async def get_execution_trace_events(
        self,
        execution_id: str,
        *,
        merge_same_id_events: bool = False,
        include_internal_events: bool = False,
    ) -> workflows_client.WorkflowExecutionTraceEventsResponse: ...


class ClientExecutionCommands:
    get_execution = staticmethod(workflows_client.get_execution)
    get_execution_history = staticmethod(workflows_client.get_execution_history)
    terminate_execution = staticmethod(workflows_client.terminate_execution)
    batch_cancel_executions = staticmethod(workflows_client.batch_cancel_executions)
    batch_terminate_executions = staticmethod(workflows_client.batch_terminate_executions)
    signal_execution = staticmethod(workflows_client.signal_execution)
    query_execution = staticmethod(workflows_client.query_execution)
    update_execution = staticmethod(workflows_client.update_execution)
    reset_execution = staticmethod(workflows_client.reset_execution)
    get_execution_logs = staticmethod(workflows_client.get_execution_logs)
    stream_execution_logs = staticmethod(workflows_client.stream_execution_logs)
    get_execution_trace_info = staticmethod(workflows_client.get_execution_trace_info)
    get_execution_trace_otel = staticmethod(workflows_client.get_execution_trace_otel)
    get_execution_trace_summary = staticmethod(workflows_client.get_execution_trace_summary)
    get_execution_trace_events = staticmethod(workflows_client.get_execution_trace_events)


# One instance, not one per request: the adapter holds no state, resolving its client per call.
_CLIENT_COMMANDS = ClientExecutionCommands()


def _commands() -> ExecutionCommands:
    return _CLIENT_COMMANDS


Commands = Annotated[ExecutionCommands, Depends(_commands)]


# 429 and the four transient 5xx the platform returns under load. 409 is absent: a create conflict
# is idempotency's answer, not a transient fault, so retrying it would hammer a request the
# platform already refused.
_RETRYABLE_STATUSES: frozenset[int] = frozenset({429, 500, 502, 503, 504})
_RETRY_ATTEMPTS = 4
_RETRY_BASE_SECONDS = 0.1
_RETRY_MAX_JITTER_SECONDS = 0.1

_T = TypeVar("_T")


async def _with_retry(call: Callable[..., Coroutine[Any, Any, _T]], *args: Any, **kwargs: Any) -> _T:
    """Call ``call`` again on a transient platform error, backing off exponentially with jitter.

    Hand-rolled, not ``tenacity``, to keep the dependency set minimal, because this ships to other
    apps. Only ``MistralError`` with a retryable status is caught; the last attempt re-raises.
    """
    last = _RETRY_ATTEMPTS - 1
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            return await call(*args, **kwargs)
        except MistralError as error:
            if attempt == last or getattr(error, "status_code", None) not in _RETRYABLE_STATUSES:
                raise
            await asyncio.sleep(_RETRY_BASE_SECONDS * 2**attempt + random.uniform(0, _RETRY_MAX_JITTER_SECONDS))
    raise AssertionError("unreachable: the loop returns or raises on the last attempt")


class RetryingExecutionCommands:
    """An ``ExecutionCommands`` that retries the idempotent reads and passes everything else through.

    A distinct class, not a wrapping in place, so ``_commands()`` still returns the plain facade.
    Only the seven side-effect-free reads are retried. Writes and ``query`` pass through, because a
    retried write could act twice. The log stream resumes with ``Last-Event-ID``.
    """

    def __init__(self, inner: ExecutionCommands) -> None:
        self._inner = inner

    async def get_execution(self, execution_id: str) -> workflows_client.WorkflowExecutionResponse:
        return await _with_retry(self._inner.get_execution, execution_id)

    async def get_execution_history(
        self, execution_id: str, *, decode_payloads: bool | None = None
    ) -> workflows_client.WorkflowExecutionHistory:
        return await _with_retry(self._inner.get_execution_history, execution_id, decode_payloads=decode_payloads)

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
        return await _with_retry(
            self._inner.get_execution_logs,
            execution_id,
            run_id=run_id,
            activity_id=activity_id,
            after=after,
            before=before,
            order=order,
            cursor=cursor,
            limit=limit,
        )

    async def get_execution_trace_info(self, execution_id: str) -> workflows_client.ExecutionTraceInfoResponse:
        return await _with_retry(self._inner.get_execution_trace_info, execution_id)

    async def get_execution_trace_otel(self, execution_id: str) -> workflows_client.WorkflowExecutionTraceOTelResponse:
        return await _with_retry(self._inner.get_execution_trace_otel, execution_id)

    async def get_execution_trace_summary(
        self, execution_id: str
    ) -> workflows_client.WorkflowExecutionTraceSummaryResponse:
        return await _with_retry(self._inner.get_execution_trace_summary, execution_id)

    async def get_execution_trace_events(
        self, execution_id: str, *, merge_same_id_events: bool = False, include_internal_events: bool = False
    ) -> workflows_client.WorkflowExecutionTraceEventsResponse:
        return await _with_retry(
            self._inner.get_execution_trace_events,
            execution_id,
            merge_same_id_events=merge_same_id_events,
            include_internal_events=include_internal_events,
        )

    async def terminate_execution(self, execution_id: str) -> None:
        await self._inner.terminate_execution(execution_id)

    async def batch_cancel_executions(self, execution_ids: list[str]) -> workflows_client.BatchExecutionResponse:
        return await self._inner.batch_cancel_executions(execution_ids)

    async def batch_terminate_executions(self, execution_ids: list[str]) -> workflows_client.BatchExecutionResponse:
        return await self._inner.batch_terminate_executions(execution_ids)

    async def signal_execution(
        self, execution_id: str, *, name: str, input: workflows_client.SignalInvocationBodyInput | None = None
    ) -> workflows_client.SignalWorkflowResponse:
        return await self._inner.signal_execution(execution_id, name=name, input=input)

    async def query_execution(
        self, execution_id: str, *, name: str, input: workflows_client.QueryInvocationBodyInput | None = None
    ) -> workflows_client.QueryWorkflowResponse:
        return await self._inner.query_execution(execution_id, name=name, input=input)

    async def update_execution(
        self, execution_id: str, *, name: str, input: workflows_client.UpdateInvocationBodyInput | None = None
    ) -> workflows_client.UpdateWorkflowResponse:
        return await self._inner.update_execution(execution_id, name=name, input=input)

    async def reset_execution(
        self,
        execution_id: str,
        *,
        event_id: int,
        reason: str | None = None,
        exclude_signals: bool = False,
        exclude_updates: bool = False,
    ) -> None:
        await self._inner.reset_execution(
            execution_id,
            event_id=event_id,
            reason=reason,
            exclude_signals=exclude_signals,
            exclude_updates=exclude_updates,
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
        return self._inner.stream_execution_logs(
            execution_id, run_id=run_id, activity_id=activity_id, after=after, last_event_id=last_event_id
        )
