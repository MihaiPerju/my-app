"""The app-owned wire contract for the workflow-execution command surface.

No model here is a vendor model. The SDK execution models are Speakeasy-generated, so handing one
to FastAPI as a ``response_model`` would freeze it into ``openapi.json`` and the generated client,
turning every SDK bump into a breaking client change. Each model maps from its SDK counterpart in a
``from_sdk`` classmethod, so a vendor rename fails ``ty`` here and a vendor addition stays out.
"""

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, Literal, Self, get_args

from pydantic import BaseModel, Field
from mistralai_capabilities.workflows import client as workflows_client

logger = logging.getLogger(__name__)

# The four SDK shapes that carry an execution envelope. Reading an attribute off the union makes a
# vendor rename a type error, because the attribute must exist on every arm.
_SdkExecution = (
    workflows_client.WorkflowExecutionResponse
    | workflows_client.WorkflowExecutionTraceOTelResponse
    | workflows_client.WorkflowExecutionTraceSummaryResponse
    | workflows_client.WorkflowExecutionTraceEventsResponse
)

_KNOWN_STATUSES: tuple[workflows_client.WorkflowExecutionStatus, ...] = get_args(
    workflows_client.WorkflowExecutionStatus
)


def _status(value: object) -> workflows_client.WorkflowExecutionStatus | None:
    """Narrow the vendor's open status union to the closed set this app publishes.

    A status never sent stays absent. One sent that we do not recognise becomes ``UNKNOWN``, not
    ``None``: the warning is the drift signal that stops it being a 500.
    """
    if not isinstance(value, str):
        return None
    # Returns the matching element, not `value`: a `str` that passes `in` is still a `str` to the
    # type checker, so narrowing to the Literal means handing back the tuple's own member.
    known = next((candidate for candidate in _KNOWN_STATUSES if candidate == value), None)
    if known is not None:
        return known
    logger.warning("unrecognised workflow execution status %r, reporting UNKNOWN", value)
    return "UNKNOWN"


def _text(value: object) -> str | None:
    """An optional SDK string, or ``None`` when it was never sent.

    Speakeasy leaves an omitted field holding an ``Unset`` model that serialises to a literal
    string. Testing for the value we want keeps that sentinel out, without importing ``mistralai``.
    """
    return value if isinstance(value, str) else None


def _number(value: object) -> int | None:
    """An optional SDK integer. Same ``Unset`` reasoning as :func:`_text`."""
    return value if isinstance(value, int) else None


def _payload(value: Any) -> Any:
    """An unschematised diagnostic payload, as plain JSON.

    ``Unset`` is a pydantic model, but the only falsy one, which is how it is dropped here. A present
    model is dumped through the SDK serialiser, which removes the sentinel from its omitted fields.
    """
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json") if value else None
    return value


def _envelope(response: _SdkExecution) -> dict[str, Any]:
    """Every field of an execution except the workflow's own result.

    One mapper for both a full read and a listed item, so the two cannot drift in which vendor
    attributes they read — the drift a type error is supposed to catch here.
    """
    return {
        "execution_id": response.execution_id,
        "workflow_name": response.workflow_name,
        "root_execution_id": response.root_execution_id,
        "status": _status(response.status),
        "start_time": response.start_time,
        "end_time": response.end_time,
        "workflow_id": _text(response.workflow_id),
        "parent_execution_id": _text(response.parent_execution_id),
        "run_id": _text(response.run_id),
        "total_duration_ms": _number(response.total_duration_ms),
    }


class WorkflowExecution(BaseModel):
    """One execution, as this app describes it.

    The vendor's twelve fields minus ``user_id`` and ``deployment_name``: the caller owns the
    execution by construction, and the deployment is infra, not contract. ``run_id`` stays, because
    a client needs it to scope a log query.

    The same model answers a full read, a listing (no ``result``), and the ``202`` on create (only
    an id yet), so only ``execution_id`` is guaranteed. One model with honest optionality beats
    three.
    """

    execution_id: str
    workflow_name: str | None = None
    root_execution_id: str | None = None
    status: workflows_client.WorkflowExecutionStatus | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    result: Any = None
    workflow_id: str | None = None
    parent_execution_id: str | None = None
    run_id: str | None = None
    total_duration_ms: int | None = None
    # A run's denormalized terminal outcome, read from the ownership store, not the platform: a
    # settled gated run has platform status `completed`, so the badge cannot come from `status`.
    # Opaque here; NULL for a run that never settles. Only the listing sets it.
    outcome: str | None = None

    @classmethod
    def from_sdk(cls, response: _SdkExecution) -> Self:
        return cls(result=response.result, **_envelope(response))

    @classmethod
    def listed(cls, response: _SdkExecution, *, outcome: str | None = None) -> Self:
        """The same execution as :meth:`from_sdk`, minus the workflow's own result.

        A listing describes executions rather than delivering them, and a result can be large, so
        inlining one per item would make a page of fifty a page of fifty payloads.

        ``outcome`` is passed in, not read off the SDK response: it is a fact this API holds in its
        ownership store, so ``_envelope`` (vendor attributes only) never carries it.
        """
        return cls(outcome=outcome, **_envelope(response))


class ExecutionPage(BaseModel):
    executions: list[WorkflowExecution] = []
    next_page_token: str | None = None

    @classmethod
    def listed(
        cls,
        responses: Sequence[_SdkExecution],
        *,
        next_page_token: str | None,
        outcomes: Mapping[str, str] | None = None,
    ) -> Self:
        by_id = outcomes or {}
        return cls(
            executions=[
                WorkflowExecution.listed(response, outcome=by_id.get(response.execution_id))
                for response in responses
            ],
            next_page_token=next_page_token,
        )


class BatchItemResult(BaseModel):
    status: str
    error: str | None = None


class BatchExecutionResult(BaseModel):
    results: dict[str, BatchItemResult] = {}

    @classmethod
    def from_sdk(cls, response: workflows_client.BatchExecutionResponse) -> Self:
        return cls(
            results={
                execution_id: BatchItemResult(status=item.status, error=_text(item.error))
                for execution_id, item in (response.results or {}).items()
            }
        )


class CancelAccepted(BaseModel):
    execution_id: str
    status: Literal["cancel_requested"] = "cancel_requested"


class TerminateAccepted(BaseModel):
    execution_id: str
    status: Literal["terminate_requested"] = "terminate_requested"


class ResetAccepted(BaseModel):
    execution_id: str
    status: Literal["reset_requested"] = "reset_requested"


class SignalAccepted(BaseModel):
    message: str | None = None

    @classmethod
    def from_sdk(cls, response: workflows_client.SignalWorkflowResponse) -> Self:
        return cls(message=response.message)


class QueryResult(BaseModel):
    query_name: str
    result: Any = None

    @classmethod
    def from_sdk(cls, response: workflows_client.QueryWorkflowResponse) -> Self:
        return cls(query_name=response.query_name, result=response.result)


class UpdateResult(BaseModel):
    update_name: str
    result: Any = None

    @classmethod
    def from_sdk(cls, response: workflows_client.UpdateWorkflowResponse) -> Self:
        return cls(update_name=response.update_name, result=response.result)


class ExecutionLogRecord(BaseModel):
    timestamp: datetime
    trace_id: str
    span_id: str
    severity_text: str
    body: str
    log_attributes: dict[str, str] = {}


class ExecutionLogPage(BaseModel):
    results: list[ExecutionLogRecord] = []
    next_cursor: str | None = None

    @classmethod
    def from_sdk(cls, response: workflows_client.ExecutionLogSearchResponse) -> Self:
        return cls(
            results=[
                ExecutionLogRecord(
                    timestamp=record.timestamp,
                    trace_id=record.trace_id,
                    span_id=record.span_id,
                    severity_text=record.severity_text,
                    body=record.body,
                    log_attributes=record.log_attributes,
                )
                for record in response.results
            ],
            next_cursor=_text(response.next_cursor),
        )


class TraceInfo(BaseModel):
    """Two scalars answering "is there a trace, and under which id" — small enough to type."""

    otel_trace_id: str | None = None
    has_trace_data: bool = False

    @classmethod
    def from_sdk(cls, response: workflows_client.ExecutionTraceInfoResponse) -> Self:
        return cls(otel_trace_id=_text(response.otel_trace_id), has_trace_data=bool(response.has_trace_data))


class ExecutionDiagnostics(BaseModel):
    """A trace read: the execution envelope, plus whatever the trace backend attached.

    ``data`` is deliberately unschematised. It is a diagnostic payload, and schematising it would
    import the whole vendor tracing model family into a contract nobody generates a client against.
    """

    execution: WorkflowExecution
    data: Any = None

    @classmethod
    def from_otel(cls, response: workflows_client.WorkflowExecutionTraceOTelResponse) -> Self:
        return cls(execution=WorkflowExecution.from_sdk(response), data=_payload(response.otel_trace_data))

    @classmethod
    def from_summary(cls, response: workflows_client.WorkflowExecutionTraceSummaryResponse) -> Self:
        return cls(execution=WorkflowExecution.from_sdk(response), data=_payload(response.span_tree))

    @classmethod
    def from_events(cls, response: workflows_client.WorkflowExecutionTraceEventsResponse) -> Self:
        return cls(execution=WorkflowExecution.from_sdk(response), data=_payload(response.events))


class ExecutionHistory(BaseModel):
    """The one operation the SDK types as bare ``Any``, so there is no envelope to keep typed."""

    data: Any = None

    @classmethod
    def from_sdk(cls, response: workflows_client.WorkflowExecutionHistory) -> Self:
        return cls(data=response)


class BatchExecutionRequest(BaseModel):
    execution_ids: list[str] = Field(min_length=1)


class SignalRequest(BaseModel):
    name: str
    # A free-form JSON object rather than the SDK's invocation-body union: `dict[str, Any]` is one
    # of that union's two arms, and the other is a base64 payload envelope no HTTP caller needs.
    input: dict[str, Any] | None = None


class QueryRequest(BaseModel):
    name: str
    input: dict[str, Any] | None = None


class UpdateRequest(BaseModel):
    name: str
    input: dict[str, Any] | None = None


class ResetRequest(BaseModel):
    event_id: int
    reason: str | None = None
    exclude_signals: bool = False
    exclude_updates: bool = False


class ExecutionEvent(BaseModel):
    """SSE payload, never a response model: the first frame of either stream."""

    execution_id: str


class StreamError(BaseModel):
    """SSE payload, never a response model: a stream that failed after the response began."""

    message: str
