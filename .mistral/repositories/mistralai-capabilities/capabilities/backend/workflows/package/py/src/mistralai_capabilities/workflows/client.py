"""Thin wrapper over the mistralai-workflows execution and worker APIs."""

import asyncio
import inspect
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, get_type_hints

import mistralai.workflows as workflows
from mistralai.workflows import workflow as _wf
from mistralai.workflows.core.config.config import (
    RESERVED_QUERY_NAMES,
    RESERVED_UPDATE_NAMES,
    PayloadEncryptionConfig,
)
from mistralai.workflows.core.config.config import config as sdk_config
from mistralai.workflows.protocol.v1.workflow import DeploymentName
from pydantic import BaseModel, SecretStr, TypeAdapter

with _wf.unsafe.imports_passed_through():
    from env.mistral import env
    from env.workflows import env as workflows_env
    from mistralai.client import Mistral
    from mistralai.client.errors import MistralError
    from mistralai.client.executions import Executions
    from mistralai.client.models import (
        BatchExecutionResponse,
        ExecutionLogSearchResponse,
        ExecutionTraceInfoResponse,
        PartialScheduleDefinition,
        QueryInvocationBodyInput,
        QueryWorkflowResponse,
        ScheduleDefinition,
        ScheduleInterval,
        SchedulePolicy,
        SignalInvocationBodyInput,
        SignalWorkflowResponse,
        UpdateInvocationBodyInput,
        UpdateWorkflowResponse,
        WorkflowExecutionListResponse,
        WorkflowExecutionResponse,
        WorkflowExecutionTraceEventsResponse,
        WorkflowExecutionTraceOTelResponse,
        WorkflowExecutionTraceSummaryResponse,
    )
    from mistralai.extra.workflows.encoding.config import WorkflowEncodingConfig
    from mistralai.extra.workflows.encoding.helpers import configure_workflow_encoding
    from mistralai.extra.workflows.helpers import get_scheduler_namespace
    from mistralai.workflows import ScheduleOverlapPolicy

    from mistralai_capabilities.workflows.encryption import payload_encryption

_SCHEDULE_CATCHUP_SECONDS = 86400

# Assigning a config attribute skips the SDK's validation, so the name is validated here instead.
_DEPLOYMENT_NAME: TypeAdapter[str | None] = TypeAdapter(DeploymentName)

# An SDK internal, not a published contract: it can move on a version bump.
_ENTRYPOINT_MARKER = "__workflows_workflow_entrypoint"

# This package owns the SDK boundary, so the vendor response models are re-exported from here:
# downstream packages import them from ``mistralai_capabilities.workflows.client`` and never from ``mistralai``.
__all__ = [
    "BatchExecutionResponse",
    "EventSource",
    "ExecutionIdMismatchError",
    "ExecutionLogSearchResponse",
    "ExecutionTraceInfoResponse",
    "MistralError",
    "QueryInvocationBodyInput",
    "QueryWorkflowResponse",
    "ScheduleTimingError",
    "SignalInvocationBodyInput",
    "SignalWorkflowResponse",
    "UpdateInvocationBodyInput",
    "UpdateWorkflowResponse",
    "WorkflowCapabilities",
    "WorkflowExecutionHistory",
    "WorkflowExecutionListResponse",
    "WorkflowExecutionResponse",
    "WorkflowExecutionStatus",
    "WorkflowExecutionTraceEventsResponse",
    "WorkflowExecutionTraceOTelResponse",
    "WorkflowExecutionTraceSummaryResponse",
    "WorkflowRun",
    "batch_cancel_executions",
    "batch_terminate_executions",
    "cancel_execution",
    "dispatch_workflow",
    "get_execution",
    "get_execution_history",
    "get_execution_logs",
    "get_execution_trace_events",
    "get_execution_trace_info",
    "get_execution_trace_otel",
    "get_execution_trace_summary",
    "infer_workflow_models",
    "list_runs",
    "pause_schedule_if_present",
    "query_execution",
    "reset_execution",
    "run_worker",
    "signal_execution",
    "start_workflow",
    "stream_execution",
    "stream_execution_logs",
    "terminate_execution",
    "update_execution",
    "upsert_schedule",
    "workflow_capabilities",
    "workflow_name",
]

# The SDK spells this ``Union[Literal[...], UnrecognizedStr]`` so an unknown server value still
# parses. Narrowing closes the Python type, so a comparison against an undefined status stops
# type-checking. It does not change the generated schema.
#
# ``UNKNOWN`` is ours. Without it an unrecognised status fails response validation and answers
# 500, turning a renderable status into an outage. Mapping to ``UNKNOWN`` keeps the contract
# enumerable and makes the warning the signal that the platform has a new state.
WorkflowExecutionStatus = Literal[
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELED",
    "TERMINATED",
    "CONTINUED_AS_NEW",
    "TIMED_OUT",
    "RETRYING_AFTER_ERROR",
    "UNKNOWN",
]

# ``get_workflow_execution_history`` is the one execution operation the SDK types as bare ``Any``:
# it generates no model for a history, so this alias is the only shape the app can promise.
WorkflowExecutionHistory = dict[str, Any]

# Where a stream reads its events from. LIVE, the platform default, starts at the connection
# and silently drops everything before it; DATABASE and HYBRID replay what was persisted. A
# consumer that attaches after the start needs one of the latter two.
EventSource = Literal["DATABASE", "LIVE", "HYBRID"]


_encoded_clients: dict[asyncio.AbstractEventLoop, asyncio.Task[Mistral]] = {}


def _new_client() -> Mistral:
    return Mistral(api_key=env.mistral_api_key, server_url=env.mistral_base_url)


async def _encoded_client(encryption: PayloadEncryptionConfig) -> Mistral:
    client = _new_client()
    # ``server_url`` is required here. ``configure_workflow_encoding`` resolves the namespace
    # itself when not given one, and does so without a server_url, which sends this
    # deployment's whoami to the public Mistral host.
    namespace = await get_scheduler_namespace(client, server_url=workflows_env.workflows_base_url)
    await configure_workflow_encoding(
        WorkflowEncodingConfig(payload_encryption=encryption),
        client=client,
        namespace=namespace,
    )
    return client


async def _client() -> Mistral:
    """The Mistral client, with payload encoding installed before its first use.

    The SDK keeps the encoding config on the client instance, so the configured client itself is
    what is cached and reused: a fresh ``Mistral`` would carry no config and send cleartext. It is
    built as one task per event loop, so concurrent first calls share one namespace lookup. A
    failed build is evicted, not cached, so a transient blip does not brick the process; it is
    re-raised because proceeding puts cleartext on the wire under ``full``.
    """
    encryption = payload_encryption()
    if encryption is None:
        return _new_client()
    loop = asyncio.get_running_loop()
    if (task := _encoded_clients.get(loop)) is None:
        task = _encoded_clients[loop] = loop.create_task(_encoded_client(encryption))
    try:
        return await task
    except BaseException:
        if _encoded_clients.get(loop) is task:
            del _encoded_clients[loop]
        raise


async def _executions() -> Executions:
    return (await _client()).workflows.executions


def _call(**kwargs: Any) -> dict[str, Any]:
    """The kwargs for one platform call: drop what the caller left unset, always target our host.

    Unset optionals are dropped because the SDK distinguishes an omitted parameter from an
    explicit ``None``, which serializes as a null the server may reject.

    ``server_url`` is added rather than accepted because omitting it silently falls back to the
    public Mistral host, which sends live traffic somewhere the deployment never meant to reach.
    """
    sent = {name: value for name, value in kwargs.items() if value is not None}
    return sent | {"server_url": workflows_env.workflows_base_url}


class ScheduleTimingError(ValueError):
    """Raised when a schedule declares neither or both of an interval and a cron expression."""


class ExecutionIdMismatchError(RuntimeError):
    """Raised when the platform starts an execution under an id other than the requested one."""


def _validated_timing(interval_seconds: int | None, cron_expressions: list[str] | None) -> None:
    if bool(interval_seconds) == bool(cron_expressions):
        raise ScheduleTimingError(
            "Provide exactly one of interval_seconds or cron_expressions. Prefer cron for a fixed "
            "time of day: an interval is anchored to the epoch, so it drifts against wall-clock time."
        )


def _schedule_fields(
    *,
    input: dict[str, Any],
    interval_seconds: int | None,
    cron_expressions: list[str] | None,
    pause_on_failure: bool,
) -> dict[str, Any]:
    """Timing and policy, shared verbatim by create and update.

    Both directions use the ``mistralai.client.models`` family. The ``mistralai.workflows``
    family spells the same shapes differently and the two are not interchangeable: a workflows
    model raises a pydantic ValidationError before any request leaves the process.
    """
    return {
        "input": input,
        "intervals": [ScheduleInterval(every=f"PT{interval_seconds}S")] if interval_seconds else [],
        "cron_expressions": cron_expressions or [],
        "policy": SchedulePolicy(
            overlap=ScheduleOverlapPolicy.SKIP,
            catchup_window_seconds=_SCHEDULE_CATCHUP_SECONDS,
            pause_on_failure=pause_on_failure,
        ),
    }


@dataclass(frozen=True)
class WorkflowRun:
    """What starting a workflow gives back: always an id, a result only if we waited."""

    execution_id: str
    result: Any = None


@dataclass(frozen=True)
class WorkflowCapabilities:
    """The command handlers a workflow class declares, as names a caller may legitimately invoke."""

    signals: tuple[str, ...]
    queries: tuple[str, ...]
    updates: tuple[str, ...]


def workflow_name(workflow_class: type) -> str:
    """The catalog identity a workflow runs under: its ``@workflow.define(name=...)``.

    This is the value the platform records the run under and the value a catalog
    (``tuple(workflow.name for ...)``) is built from, so an ownership row keyed on it is the row an
    id-addressed read will find. Raises the SDK's ``ValueError`` for a class never ``@workflow.define``d.
    """
    return workflows.get_workflow_definition(workflow_class).name


def workflow_capabilities(workflow_class: type) -> WorkflowCapabilities:
    """Which of signal, query and update a workflow actually answers.

    Lets a caller-facing surface publish only the commands a workflow can serve. Framework-reserved
    handlers are excluded: the reserved sets come from the SDK, so a new internal handler drops out
    of the contract on the next bump. The SDK publishes no reserved-signal set, so every declared
    signal belongs to the author. Raises the SDK's ``ValueError`` for a class never ``@workflow.define``d.
    """
    definition = workflows.get_workflow_definition(workflow_class)
    return WorkflowCapabilities(
        signals=tuple(handler.name for handler in definition.signals),
        queries=tuple(handler.name for handler in definition.queries if handler.name not in RESERVED_QUERY_NAMES),
        updates=tuple(handler.name for handler in definition.updates if handler.name not in RESERVED_UPDATE_NAMES),
    )


def infer_workflow_models(workflow_class: type) -> tuple[type[BaseModel], Any | None]:
    """The request and response types a workflow's entrypoint declares.

    Here rather than in a caller because it needs ``_ENTRYPOINT_MARKER``: ``WorkflowSpec``
    publishes JSON schema, not the model classes. Raises ``ValueError`` like
    :func:`workflow_capabilities`.
    """
    entrypoint = next(
        (
            method
            for _, method in inspect.getmembers(workflow_class, predicate=inspect.isfunction)
            if hasattr(method, _ENTRYPOINT_MARKER)
        ),
        None,
    )
    if entrypoint is None:
        raise ValueError(f"{workflow_class.__name__} has no workflow entrypoint")

    original = inspect.unwrap(entrypoint)
    hints = get_type_hints(original)
    parameters = [parameter for name, parameter in inspect.signature(original).parameters.items() if name != "self"]
    if len(parameters) != 1:
        raise ValueError(f"{workflow_class.__name__} must take exactly one entrypoint argument, not {len(parameters)}")

    request_type = hints.get(parameters[0].name)
    if not inspect.isclass(request_type) or not issubclass(request_type, BaseModel):
        raise ValueError(f"{workflow_class.__name__} entrypoint input must be a Pydantic model")

    return request_type, hints.get("return")


async def start_workflow(
    workflow_class: type,
    workflow_input: BaseModel,
    *,
    wait_for_result: bool,
    timeout_seconds: float | None = None,
    execution_id: str | None = None,
) -> WorkflowRun:
    """Start a workflow through the remote execution API.

    ``exclude_unset`` matters: the input models give optional fields defaults the SDK also
    defaults, and sending them explicitly is not the same request.

    ``execution_id`` lets a caller name the execution before it exists, which makes "authorise
    first, then start" possible. Omitted, ``_call`` drops it and the platform generates one.
    """
    response = await (await _client()).workflows.execute_workflow_async(
        **_call(
            workflow_identifier=workflows.get_workflow_definition(workflow_class).name,
            execution_id=execution_id,
            input=workflow_input.model_dump(mode="json", exclude_unset=True),
            wait_for_result=wait_for_result,
            timeout_seconds=timeout_seconds,
            deployment_name=workflows_env.deployment_name,
        )
    )
    # The id still comes off the RESPONSE, so the server stays the authority on what it started.
    # But a caller that supplied one has committed to it elsewhere (an authorization row keyed on
    # it), so a disagreement means the running thing is not the authorised thing.
    if execution_id is not None and response.execution_id != execution_id:
        raise ExecutionIdMismatchError(
            f"Asked the platform to start {execution_id!r} and it started {response.execution_id!r}."
        )
    return WorkflowRun(execution_id=response.execution_id, result=getattr(response, "result", None))


async def stream_execution(
    execution_id: str,
    *,
    event_source: EventSource | None = None,
    last_event_id: str | None = None,
) -> AsyncIterator[Any]:
    """Consume a running execution's events. ``last_event_id`` resumes after a dropped stream.

    ``event_source`` makes a consumer that attaches after the start whole: DATABASE and HYBRID
    replay persisted events first, where the LIVE default drops everything before the connection.
    """
    stream = await (await _executions()).stream_async(
        **_call(execution_id=execution_id, event_source=event_source, last_event_id=last_event_id)
    )
    async with stream:
        async for event in stream:
            yield event


async def cancel_execution(execution_id: str) -> None:
    await (await _executions()).cancel_workflow_execution_async(**_call(execution_id=execution_id))


async def get_execution(execution_id: str) -> WorkflowExecutionResponse:
    return await (await _executions()).get_workflow_execution_async(**_call(execution_id=execution_id))


async def get_execution_history(
    execution_id: str,
    *,
    decode_payloads: bool | None = None,
) -> WorkflowExecutionHistory:
    return await (await _executions()).get_workflow_execution_history_async(
        **_call(execution_id=execution_id, decode_payloads=decode_payloads)
    )


async def terminate_execution(execution_id: str) -> None:
    await (await _executions()).terminate_workflow_execution_async(**_call(execution_id=execution_id))


async def batch_cancel_executions(execution_ids: list[str]) -> BatchExecutionResponse:
    return await (await _executions()).batch_cancel_workflow_executions_async(**_call(execution_ids=execution_ids))


async def batch_terminate_executions(execution_ids: list[str]) -> BatchExecutionResponse:
    return await (await _executions()).batch_terminate_workflow_executions_async(**_call(execution_ids=execution_ids))


async def signal_execution(
    execution_id: str,
    *,
    name: str,
    input: SignalInvocationBodyInput | None = None,
) -> SignalWorkflowResponse:
    return await (await _executions()).signal_workflow_execution_async(
        **_call(execution_id=execution_id, name=name, input=input)
    )


async def query_execution(
    execution_id: str,
    *,
    name: str,
    input: QueryInvocationBodyInput | None = None,
) -> QueryWorkflowResponse:
    return await (await _executions()).query_workflow_execution_async(
        **_call(execution_id=execution_id, name=name, input=input)
    )


async def update_execution(
    execution_id: str,
    *,
    name: str,
    input: UpdateInvocationBodyInput | None = None,
) -> UpdateWorkflowResponse:
    return await (await _executions()).update_workflow_execution_async(
        **_call(execution_id=execution_id, name=name, input=input)
    )


async def reset_execution(
    execution_id: str,
    *,
    event_id: int,
    reason: str | None = None,
    exclude_signals: bool = False,
    exclude_updates: bool = False,
) -> None:
    await (await _executions()).reset_workflow_async(
        **_call(
            execution_id=execution_id,
            event_id=event_id,
            reason=reason,
            exclude_signals=exclude_signals,
            exclude_updates=exclude_updates,
        )
    )


async def get_execution_logs(
    execution_id: str,
    *,
    run_id: str | None = None,
    activity_id: str | None = None,
    after: datetime | None = None,
    before: datetime | None = None,
    order: Literal["asc", "desc"] | None = None,
    cursor: str | None = None,
    limit: int | None = None,
) -> ExecutionLogSearchResponse:
    return await (await _executions()).get_workflow_execution_logs_async(
        **_call(
            execution_id=execution_id,
            run_id=run_id,
            activity_id=activity_id,
            after=after,
            before=before,
            order=order,
            cursor=cursor,
            limit=limit,
        )
    )


async def stream_execution_logs(
    execution_id: str,
    *,
    run_id: str | None = None,
    activity_id: str | None = None,
    after: datetime | None = None,
    last_event_id: str | None = None,
) -> AsyncIterator[Any]:
    stream = await (await _executions()).stream_workflow_execution_logs_async(
        **_call(
            execution_id=execution_id,
            run_id=run_id,
            activity_id=activity_id,
            after=after,
            last_event_id=last_event_id,
        )
    )
    async with stream:
        async for event in stream:
            yield event


async def get_execution_trace_info(execution_id: str) -> ExecutionTraceInfoResponse:
    return await (await _executions()).get_workflow_execution_trace_info_async(**_call(execution_id=execution_id))


async def get_execution_trace_otel(execution_id: str) -> WorkflowExecutionTraceOTelResponse:
    return await (await _executions()).get_workflow_execution_trace_otel_async(**_call(execution_id=execution_id))


async def get_execution_trace_summary(execution_id: str) -> WorkflowExecutionTraceSummaryResponse:
    return await (await _executions()).get_workflow_execution_trace_summary_async(**_call(execution_id=execution_id))


async def get_execution_trace_events(
    execution_id: str,
    *,
    merge_same_id_events: bool = False,
    include_internal_events: bool = False,
) -> WorkflowExecutionTraceEventsResponse:
    return await (await _executions()).get_workflow_execution_trace_events_async(
        **_call(
            execution_id=execution_id,
            merge_same_id_events=merge_same_id_events,
            include_internal_events=include_internal_events,
        )
    )


async def list_runs(
    *,
    workflow_identifier: str | None = None,
    root_execution_id: str | None = None,
    search: str | None = None,
    status: WorkflowExecutionStatus | list[WorkflowExecutionStatus] | None = None,
    deployment_name: str | None = None,
    sort_by: Literal["start_time", "end_time"] | None = None,
    order: Literal["asc", "desc"] | None = None,
    start_time_after: datetime | None = None,
    start_time_before: datetime | None = None,
    end_time_after: datetime | None = None,
    end_time_before: datetime | None = None,
    user_id: str | None = None,
    workflow_tags: list[str] | None = None,
    include_internal: bool | None = None,
    page_size: int | None = None,
    next_page_token: str | None = None,
) -> WorkflowExecutionListResponse | None:
    """List executions. Every filter the platform offers is exposed; narrowing belongs to callers.

    A caller-facing surface must force ``user_id`` and ``workflow_identifier`` server-side, but
    that decision cannot be made here, where the package has no notion of a caller.
    """
    response = await (await _client()).workflows.runs.list_runs_async(
        **_call(
            workflow_identifier=workflow_identifier,
            root_execution_id=root_execution_id,
            search=search,
            status=status,
            deployment_name=deployment_name,
            sort_by=sort_by,
            order=order,
            start_time_after=start_time_after,
            start_time_before=start_time_before,
            end_time_after=end_time_after,
            end_time_before=end_time_before,
            user_id=user_id,
            workflow_tags=workflow_tags,
            include_internal=include_internal,
            page_size=page_size,
            next_page_token=next_page_token,
        )
    )
    # The SDK wraps the page in an envelope whose sibling field is a ``next`` callable. Only the
    # page is data, and a callable cannot cross this boundary into a serializable contract.
    return response.result if response is not None else None


def _configure_worker() -> None:
    """Point the SDK's module-level config at the app's own settings.

    The SDK reads its settings from the environment when ``mistralai.workflows`` is imported,
    which can be before ``env`` has loaded the repo-root ``.env``. Its own names differ too
    (``SERVER_URL``), so without this the worker would poll the public host whatever
    ``WORKFLOWS_BASE_URL`` says, and run under whatever key and queue the SDK happened to see.
    """
    worker = sdk_config.worker
    # The payload codec is built inside ``workflows.run_worker`` from this value. The assignment is
    # unconditional, ``None`` included, so a value the SDK parsed from
    # ``TEMPORAL_PAYLOAD_ENCRYPTION__*`` cannot leak as a second source.
    worker.temporal_payload_encryption = payload_encryption()
    # The agent client (and the telemetry endpoint derived from it) defaults to ``server_url`` at
    # construction, so it only follows the move when nobody set it on purpose.
    if worker.agent.mistral_client_server_url in (None, worker.server_url):
        worker.agent.mistral_client_server_url = workflows_env.workflows_base_url
    worker.server_url = workflows_env.workflows_base_url
    if env.mistral_api_key:
        sdk_config.common.mistral_api_key = SecretStr(env.mistral_api_key)
    if workflows_env.deployment_name:
        worker.deployment_name = _DEPLOYMENT_NAME.validate_python(workflows_env.deployment_name)


async def run_worker(workflow_classes: list[type]) -> Any:
    """Run the worker, configured from our own settings.

    The config is assigned immediately before delegating. ``workflows.run_worker`` deep-copies it
    on entry and restores that copy on exit. Config discovery is on, so it authenticates from
    ``common.mistral_api_key``: its own ``api_key`` argument applies only with discovery off.
    """
    _configure_worker()
    return await workflows.run_worker(workflow_classes)


async def dispatch_workflow(workflow_class: type, workflow_input: BaseModel) -> Any:
    """Dispatch a workflow to the worker via the remote execution API and wait for completion.

    Use this for worker-only workflows (e.g. evals) that cannot run inline with
    ``mistralai.workflows.execute_workflow`` because they use Temporal workflow APIs internally.
    """
    return await (await _client()).workflows.execute_workflow_and_wait_async(
        **_call(
            workflow_identifier=workflows.get_workflow_definition(workflow_class).name,
            input=workflow_input,
            deployment_name=workflows_env.deployment_name,
        )
    )


async def pause_schedule_if_present(*, schedule_id: str, note: str) -> bool:
    """Pause an existing schedule; return False when there is nothing to pause.

    Pausing rather than deleting keeps history and allows resume. A missing schedule surfaces as a
    generic SDKError carrying a 404, not a typed not-found, so the status check is deliberate.
    """
    schedules = (await _client()).workflows.schedules
    try:
        await schedules.pause_schedule_async(**_call(schedule_id=schedule_id, note=note))
    except MistralError as error:
        if getattr(error, "status_code", None) != 404:
            raise
        return False
    return True


async def upsert_schedule(
    *,
    schedule_id: str,
    workflow_identifier: str,
    input: dict[str, Any],
    interval_seconds: int | None = None,
    cron_expressions: list[str] | None = None,
    pause_on_failure: bool = False,
    deployment_name: str | None = None,
) -> Any:
    """Idempotently ensure a recurring workflow schedule exists and matches this config.

    Timing is exactly one of ``interval_seconds`` or ``cron_expressions`` (5-field UTC cron); an
    interval is anchored to the epoch and drifts. Re-running on every deploy converges, because the
    platform resolves an existing ``schedule_id`` to an update. This cannot resume: no create or
    update model carries ``paused``, so a paused schedule stays paused until a caller resumes it.
    """
    _validated_timing(interval_seconds, cron_expressions)
    schedules = (await _client()).workflows.schedules
    fields = _schedule_fields(
        input=input,
        interval_seconds=interval_seconds,
        cron_expressions=cron_expressions,
        pause_on_failure=pause_on_failure,
    )
    try:
        return await schedules.schedule_workflow_async(
            **_call(
                schedule=ScheduleDefinition(schedule_id=schedule_id, **fields),
                workflow_identifier=workflow_identifier,
                deployment_name=deployment_name,
            )
        )
    except MistralError:
        # Should be unreachable: the platform upserts. This is a blind retry, because a duplicate
        # is not documented to return a specific status. A real auth or validation fault fails the
        # PATCH too and propagates from there.
        return await schedules.update_schedule_async(
            **_call(schedule_id=schedule_id, schedule=PartialScheduleDefinition(**fields))
        )
