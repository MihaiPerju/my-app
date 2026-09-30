"""One workflow class in, the whole execution command surface out.

``WorkflowRouter`` builds the routes to drive, observe, and stop one workflow execution. Ownership
is 404, never 403: every id-addressed route runs ``ownership.require_owned`` as a dependency.
Endpoints are closures, so each sets its own ``__name__`` and annotations. Collaborators are
dependencies, so ``create_app()`` takes no arguments.
"""

import asyncio
from collections.abc import AsyncIterator, Callable, Coroutine, Sequence
from datetime import datetime
from types import FunctionType
from typing import Annotated, Any, Literal, Protocol, get_args
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from mistralai_capabilities.fastapi_workflows_auth.commands import (
    Cancel,
    Commands,
    ExecutionCommands,
    Start,
    StartWorkflow,
    Stream,
    StreamExecution,
)
from mistralai_capabilities.fastapi_workflows_auth.ownership import (
    UNKNOWN_EXECUTION,
    Executions,
    ExecutionStore,
    require_owned,
)
from mistralai_capabilities.fastapi_workflows_auth.schemas import (
    BatchExecutionRequest,
    BatchExecutionResult,
    CancelAccepted,
    ExecutionDiagnostics,
    ExecutionEvent,
    ExecutionHistory,
    ExecutionLogPage,
    ExecutionPage,
    QueryRequest,
    QueryResult,
    ResetAccepted,
    ResetRequest,
    SignalAccepted,
    SignalRequest,
    StreamError,
    TerminateAccepted,
    TraceInfo,
    UpdateRequest,
    UpdateResult,
    WorkflowExecution,
)
from mistralai_capabilities.fastapi_auth.identity import CurrentUser
from mistralai_capabilities.fastapi.sse import event_stream_response, format_sse
from pydantic import BaseModel, Field
from mistralai_capabilities.workflows import client as workflows_client
from mistralai_capabilities.workflows.client import MistralError


class WorkflowRouteConfigurationError(ValueError):
    """Raised when a workflow class cannot be mapped to an HTTP route."""


Operation = Literal[
    "create_execution",
    "list_executions",
    "batch_cancel",
    "batch_terminate",
    "get_execution",
    "execution_history",
    "execution_stream",
    "execution_cancel",
    "execution_terminate",
    "execution_reset",
    "execution_signal",
    "execution_query",
    "execution_update",
    "execution_logs",
    "execution_logs_stream",
    "execution_trace_info",
    "execution_trace_otel",
    "execution_trace_summary",
    "execution_trace_events",
]

ALL_OPERATIONS: frozenset[Operation] = frozenset(get_args(Operation))

# The three operations that address a *declared handler* rather than the execution itself, so
# they are the only ones a workflow can fail to support. Everything else is unconditional.
_COMMAND_OPERATIONS: frozenset[Operation] = frozenset({"execution_signal", "execution_query", "execution_update"})

# The parameter is `Any`, not `BaseModel`, because an adapter is written against the caller's own
# `request_model`, which is narrower. `BaseModel` would reject every honest adapter, and making the
# factory generic in the request model buys nothing here.
InputAdapter = Callable[[Any], BaseModel]

# A mapper receives the whole frame stream, not one frame. An outgoing event may need several
# frames of context, such as a snapshot rebuilt from deltas, and a terminal event needs to see the
# stream end. The factory calls the mapper once per request, so the generator's locals are
# per-stream. A per-frame callable is shared by every concurrent caller and can hold no state.
EventMapper = Callable[[AsyncIterator[Any]], AsyncIterator[tuple[str, Any]]]


class CreateRefusal(BaseModel):
    """A create refusal that names its own status, for a hook that must refuse as something but 404.

    The default hook return is a bool and the default refusal is the 404 the ownership convention
    requires. A hook whose refusal is a different fact returns one of these instead of raising, so
    the status code stays in the router, not in the feature-layer hook. ``detail`` is whatever
    FastAPI serialises as an error body: a string, or a list of field errors.
    """

    model_config = {"frozen": True}

    status_code: int = Field(ge=400, le=599)
    detail: Any


class CreateHook(Protocol):
    """Work one mount needs done between recording ownership and starting the workflow.

    An escape hatch a single mount opts into; leave it unset and the route is unchanged. Return
    ``False`` or ``None`` to refuse with the ownership 404, or a :class:`CreateRefusal` naming a
    different status. A Protocol, not a ``Callable`` alias, because the arguments are keyword-only.
    """

    async def __call__(self, *, execution_id: str, body: Any, user_id: str) -> bool | CreateRefusal: ...


_NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"description": "Unknown execution"}}
_SSE: dict[int | str, dict[str, Any]] = {200: {"content": {"text/event-stream": {}}}}


class _Mount(Protocol):
    """Register one route, or skip it when ``operations`` excludes it.

    Keyword-only from ``options`` on, which a ``Callable`` alias cannot express. This is the same
    reason ``mistralai_capabilities.fastapi_workflows_auth.commands`` uses a Protocol.
    """

    def __call__(
        self,
        operation: Operation,
        method: str,
        path: str,
        endpoint: FunctionType,
        **options: Any,
    ) -> None: ...


class ExecutionRoute(APIRoute):
    """An id-addressed route, where the platform not knowing the execution means 404, not 500.

    The route runs only after ownership confirms the caller owns the id, so a platform 404 means
    the ownership row outlived the execution. It answers with the unowned-id phrase, so an owner
    cannot tell a withdrawn execution from one never theirs. Only the 404 is reinterpreted; a 429
    or 503 keeps surfacing. A ``route_class`` avoids relabeling 404s from other ``clients`` modules.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()
        if "{execution_id}" not in self.path:
            return handler

        async def translate(request: Request) -> Response:
            try:
                return await handler(request)
            except MistralError as error:
                if getattr(error, "status_code", None) != 404:
                    raise
                raise HTTPException(status_code=404, detail=UNKNOWN_EXECUTION) from error

        return translate


def _mounter(router: APIRouter, name: str, ownership_name: str, operations: frozenset[Operation]) -> _Mount:
    """Register routes for one mount, and guard every id-addressed path.

    The path is the discriminator. A route addressed by ``{execution_id}`` is reachable with
    someone else's id, so it gets the ownership dependency and the documented 404 automatically.
    Op-ids come from ``name``; the ownership guard checks ``ownership_name``, so a consumer can
    freeze op-ids across a catalog rename without desyncing the read side.
    """
    owned = Depends(require_owned(ownership_name))

    def mount(operation: Operation, method: str, path: str, endpoint: FunctionType, **options: Any) -> None:
        if operation not in operations:
            return
        operation_id = f"{name}_{operation}"
        endpoint.__name__ = operation_id
        dependencies = list(options.pop("dependencies", None) or ())
        responses = dict(options.pop("responses", None) or {})
        if "{execution_id}" in path:
            dependencies.insert(0, owned)
            responses.update(_NOT_FOUND)
        router.add_api_route(
            path,
            endpoint,
            methods=[method],
            name=operation_id,
            operation_id=operation_id,
            dependencies=dependencies,
            responses=responses or None,
            **options,
        )

    return mount


def _resolve_request_model(
    workflow_class: type,
    request_model: type[BaseModel] | None,
    input_adapter: InputAdapter | None,
) -> tuple[type[BaseModel], Any | None]:
    """The wire model and, when inferred, the workflow's declared return type.

    Explicit wins and skips inference. A workflow whose entrypoint takes a discriminated union
    cannot be reflected, so inference would fail a mount that already declared its own contract.
    """
    if input_adapter is not None and request_model is None:
        raise WorkflowRouteConfigurationError(
            f"{workflow_class.__name__} was given input_adapter= without request_model=. They are a pair: "
            "inference cannot supply the wire type an adapter converts from."
        )
    if request_model is not None:
        return request_model, None
    try:
        return workflows_client.infer_workflow_models(workflow_class)
    except ValueError as error:
        raise WorkflowRouteConfigurationError(
            f"Cannot infer a request model for {workflow_class.__name__}: {error}. "
            "Pass request_model= and input_adapter= to declare the wire contract explicitly."
        ) from error


def _resolve_operations(workflow_class: type, operations: frozenset[Operation] | None) -> frozenset[Operation]:
    """The surface to emit: derived from what the workflow declares, unless told otherwise.

    An explicit set overrides in both directions. It can add an operation the workflow does not
    declare and drop one it does, because narrowing the surface is a mount's decision.
    """
    if operations is not None:
        unknown = operations - ALL_OPERATIONS
        if unknown:
            raise WorkflowRouteConfigurationError(
                f"Unknown operations for {workflow_class.__name__}: {sorted(unknown)}. "
                f"Valid operations are {sorted(ALL_OPERATIONS)}."
            )
        return operations

    try:
        capabilities = workflows_client.workflow_capabilities(workflow_class)
    except ValueError as error:
        raise WorkflowRouteConfigurationError(
            f"Cannot derive the operations of {workflow_class.__name__}: {error}. "
            "Pass operations= to declare the surface explicitly."
        ) from error

    declared: set[Operation] = set()
    if capabilities.signals:
        declared.add("execution_signal")
    if capabilities.queries:
        declared.add("execution_query")
    if capabilities.updates:
        declared.add("execution_update")
    return (ALL_OPERATIONS - _COMMAND_OPERATIONS) | declared


def WorkflowRouter(
    workflow_class: type,
    *,
    name: str,
    ownership_name: str | None = None,
    prefix: str = "",
    request_model: type[BaseModel] | None = None,
    input_adapter: InputAdapter | None = None,
    response_model: Any | None = None,
    wait_for_result: bool = False,
    operations: frozenset[Operation] | None = None,
    stream_events: EventMapper | None = None,
    on_create: CreateHook | None = None,
    tags: Sequence[str] = (),
) -> APIRouter:
    """The execution command surface for ``workflow_class``, as a mountable router.

    ``name`` is the operation-id namespace: it prefixes every route's op-id and so names the
    generated client's methods. It is free to differ from the workflow's catalog identity, so a
    consumer can freeze op-ids across a catalog rename without churning the generated client.

    Ownership is written on create and checked by every id-addressed read under the workflow's
    catalog name (its ``@workflow.define(name=...)``) — the value a catalog is built from, so create
    and read agree by construction. ``ownership_name`` is an optional assertion of that identity: if
    given and it disagrees with the workflow's catalog name, construction fails rather than silently
    recording runs that every read would 404. ``operations`` defaults to the set the workflow
    declares, so a workflow with no signal handler publishes no ``/signals`` route to 404 against.
    """
    body_model, inferred_response = _resolve_request_model(workflow_class, request_model, input_adapter)
    adapt: InputAdapter = input_adapter if input_adapter is not None else lambda body: body
    result_model = response_model if response_model is not None else inferred_response
    resolved_operations = _resolve_operations(workflow_class, operations)

    # The workflow's define-name is the identity reads check, so ownership derives from it, not from
    # `name`. Derived after operations resolution so a class that was never `@workflow.define`d fails
    # with that error first — unless request_model= and operations= bypassed both reflection paths,
    # in which case this lookup is the last guard and must stay inside the factory's error boundary.
    # A class with no definition cannot be started either (`start_workflow` resolves it too), so it
    # is rejected here rather than 500ing at request time; an explicit `ownership_name` cannot stand
    # in for a missing definition, it only asserts a real one.
    try:
        catalog_name = workflows_client.workflow_name(workflow_class)
    except ValueError as error:
        raise WorkflowRouteConfigurationError(
            f"{workflow_class.__name__} has no workflow definition ({error}); it cannot own or start "
            "executions. Decorate it with @workflow.define(name=...)."
        ) from error
    if ownership_name is not None and ownership_name != catalog_name:
        raise WorkflowRouteConfigurationError(
            f"ownership_name={ownership_name!r} does not match the workflow's catalog name "
            f"{catalog_name!r}. Reads check the catalog name, so a run recorded under "
            f"{ownership_name!r} would 404 on every id-addressed read. Drop ownership_name= to "
            f"use the catalog name, or rename the workflow's @workflow.define(name=...)."
        )
    ownership_name = catalog_name

    router = APIRouter(prefix=prefix, tags=list(tags), route_class=ExecutionRoute)
    mount = _mounter(router, name, ownership_name, resolved_operations)

    # The two batch routes are literal paths in the segment `/executions/{execution_id}` claims,
    # so they are registered first: FastAPI matches in registration order, and the parameterised
    # route would otherwise swallow `/executions/cancel` and answer it as an id lookup.
    _add_create_execution(
        mount, ownership_name, workflow_class, body_model, adapt, result_model, wait_for_result, on_create
    )
    _add_list_executions(mount, ownership_name)
    _add_batch_cancel(mount, ownership_name)
    _add_batch_terminate(mount, ownership_name)

    _add_get_execution(mount, name)
    _add_execution_history(mount, name)
    _add_execution_stream(mount, name, stream_events)
    _add_execution_cancel(mount, name)
    _add_execution_terminate(mount, name)
    _add_execution_reset(mount, name)
    _add_execution_signal(mount, name)
    _add_execution_query(mount, name)
    _add_execution_update(mount, name)
    _add_execution_logs(mount, name)
    _add_execution_logs_stream(mount, name)
    _add_execution_trace_info(mount, name)
    _add_execution_trace_otel(mount, name)
    _add_execution_trace_summary(mount, name)
    _add_execution_trace_events(mount, name)
    return router


def _add_create_execution(
    mount: _Mount,
    ownership_name: str,
    workflow_class: type,
    body_model: type[BaseModel],
    adapt: InputAdapter,
    result_model: Any | None,
    wait_for_result: bool,
    on_create: CreateHook | None,
) -> None:
    async def _hook_and_start(
        execution_id: str, body: BaseModel, start: StartWorkflow, user_id: str, executions: ExecutionStore
    ) -> Any:
        # `on_create` runs inside the ownership window. Keep the order: record, hook, start, so a
        # worker-side reader does not race the write. Any error here leaves a claim for an execution
        # that never started, so `discard` withdraws the claim before the error propagates. Without
        # it, a create with an `Idempotency-Key` fails once and then succeeds forever.
        try:
            if on_create is not None:
                outcome = await on_create(execution_id=execution_id, body=body, user_id=user_id)
                if isinstance(outcome, CreateRefusal):
                    # A hook refusing as something other than not-found: the router owns the status
                    # code, the hook only named it.
                    raise HTTPException(status_code=outcome.status_code, detail=outcome.detail)
                if not outcome:
                    # The same phrase every other ownership refusal uses, deliberately. A distinct one
                    # per resource would tell a caller which check it tripped, which is the oracle the
                    # 404-not-403 convention exists to deny (D3).
                    raise HTTPException(status_code=404, detail=UNKNOWN_EXECUTION)
            run = await start(workflow_class, adapt(body), wait_for_result=wait_for_result, execution_id=execution_id)
        except Exception:
            await executions.discard(execution_id=execution_id, user_id=user_id, workflow_name=ownership_name)
            raise
        return run.result if wait_for_result else WorkflowExecution(execution_id=run.execution_id)

    async def create_execution(
        body: BaseModel, start: Start, executions: Executions, user: CurrentUser, idempotency_key: str | None = None
    ) -> Any:
        # The id is minted here and written before the workflow starts, so no running execution is
        # owned by nobody. `reserve_execution` folds the ownership write and the idempotency claim
        # into one atomic step. A retry that repeats the caller's `Idempotency-Key` gets back the
        # first id and returns it without starting a second workflow. Uniqueness is scoped to
        # (user, workflow, key), so a foreign key is a normal miss and the id stays server-minted.
        execution_id = str(uuid4())
        if idempotency_key is not None:
            reserved = await executions.reserve_execution(
                execution_id=execution_id,
                user_id=user.user_id,
                workflow_name=ownership_name,
                idempotency_key=idempotency_key,
            )
            if reserved != execution_id:
                return WorkflowExecution(execution_id=reserved)
        else:
            await executions.record(execution_id=execution_id, user_id=user.user_id, workflow_name=ownership_name)
        return await _hook_and_start(execution_id, body, start, user.user_id, executions)

    async def create_execution_waited(body: BaseModel, start: Start, executions: Executions, user: CurrentUser) -> Any:
        # A waited create returns the workflow's own result, which cannot be reconstructed for a
        # replay from an ownership row alone, so idempotency is not offered here — the header is
        # absent from this route entirely, keeping the waited mounts (speech) byte-for-byte.
        execution_id = str(uuid4())
        await executions.record(execution_id=execution_id, user_id=user.user_id, workflow_name=ownership_name)
        return await _hook_and_start(execution_id, body, start, user.user_id, executions)

    endpoint = create_execution_waited if wait_for_result else create_execution
    returns = result_model if wait_for_result else WorkflowExecution
    # The concrete per-mount types, substituted onto the placeholder annotations the closure was
    # declared with (`body: BaseModel`). FastAPI builds the route from `__annotations__`, and
    # `body_model` — a parameter of the enclosing factory — is reachable from here and from
    # nowhere FastAPI would look on its own.
    endpoint.__annotations__ = {
        "body": body_model,
        "start": Start,
        "executions": Executions,
        "user": CurrentUser,
        "return": returns if returns is not None else Any,
    }
    if not wait_for_result:
        endpoint.__annotations__["idempotency_key"] = Annotated[str | None, Header(alias="Idempotency-Key")]
    mount(
        "create_execution",
        "POST",
        "/executions",
        endpoint,
        status_code=200 if wait_for_result else 202,
        response_model=returns,
        # Documented only where it can happen. A mount with no hook has no way to answer 404
        # here, and publishing one anyway would put a response in the contract that no code
        # path produces — the generated client would type-guard against nothing.
        responses=_NOT_FOUND if on_create is not None else None,
        summary="Start an execution",
    )


_DEFAULT_PAGE_SIZE = 50
# The page is hydrated with one platform read per id, so its size is the fan-out. Capped at the
# same hundred the platform allows in a batch body rather than left to the query string.
_MAX_PAGE_SIZE = 100


def _add_list_executions(mount: _Mount, ownership_name: str) -> None:
    """The caller's own executions, paged out of the ownership table.

    The ownership table is the only place the caller is recorded; the platform ``user_id`` is this
    API's service principal and is the same for everybody. This rationale lives on the factory, not
    the endpoint, because FastAPI publishes an endpoint docstring as the operation ``description``.
    ``status`` is applied after hydration, so a page may come back shorter than ``page_size``;
    ``next_page_token`` says whether more remain.
    """

    async def list_executions(
        commands: Commands,
        executions: Executions,
        user: CurrentUser,
        status: Annotated[workflows_client.WorkflowExecutionStatus | None, Query()] = None,
        start_time_after: datetime | None = None,
        start_time_before: datetime | None = None,
        page_size: int | None = None,
        next_page_token: str | None = None,
    ) -> ExecutionPage:
        limit = min(page_size or _DEFAULT_PAGE_SIZE, _MAX_PAGE_SIZE)
        execution_ids = await executions.list_owned(
            user_id=user.user_id,
            workflow_name=ownership_name,
            limit=limit,
            after_id=next_page_token,
            created_after=start_time_after,
            created_before=start_time_before,
        )
        # One batch read for the whole page's outcome badges, next to the hydration fan-out rather
        # than a per-row workflow query. A workflow whose runs never settle returns an empty map.
        outcomes = (
            await executions.outcomes(execution_ids=execution_ids, user_id=user.user_id) if execution_ids else {}
        )
        hydrated = await asyncio.gather(*(_describe(commands, execution_id) for execution_id in execution_ids))
        return ExecutionPage.listed(
            [
                execution
                for execution in hydrated
                if execution is not None and (status is None or execution.status == status)
            ],
            # The cursor is the last id of the UNFILTERED page, so paging advances even when the
            # status filter empties the page. A short page is not the end of the listing.
            next_page_token=execution_ids[-1] if len(execution_ids) == limit else None,
            outcomes=outcomes,
        )

    mount("list_executions", "GET", "/executions", list_executions, summary="List this caller's executions")


async def _describe(
    commands: ExecutionCommands, execution_id: str
) -> workflows_client.WorkflowExecutionResponse | None:
    """One execution as the platform sees it, or ``None`` if the platform has never heard of it.

    An owned id the platform cannot resolve is a row whose execution never started. It is rare but
    reachable, and one such row must not turn the whole listing into a 500.
    """
    try:
        return await commands.get_execution(execution_id)
    except MistralError as error:
        if getattr(error, "status_code", None) == 404:
            return None
        raise


def _add_batch_cancel(mount: _Mount, ownership_name: str) -> None:
    async def batch_cancel(
        body: BatchExecutionRequest, commands: Commands, executions: Executions, user: CurrentUser
    ) -> BatchExecutionResult:
        await _require_all_owned(executions, body.execution_ids, user.user_id, ownership_name)
        return BatchExecutionResult.from_sdk(await commands.batch_cancel_executions(body.execution_ids))

    mount(
        "batch_cancel",
        "POST",
        "/executions/cancel",
        batch_cancel,
        responses=_NOT_FOUND,
        summary="Stop several executions",
    )


def _add_batch_terminate(mount: _Mount, ownership_name: str) -> None:
    async def batch_terminate(
        body: BatchExecutionRequest, commands: Commands, executions: Executions, user: CurrentUser
    ) -> BatchExecutionResult:
        await _require_all_owned(executions, body.execution_ids, user.user_id, ownership_name)
        return BatchExecutionResult.from_sdk(await commands.batch_terminate_executions(body.execution_ids))

    mount(
        "batch_terminate",
        "POST",
        "/executions/terminate",
        batch_terminate,
        responses=_NOT_FOUND,
        summary="Terminate several executions",
    )


async def _require_all_owned(
    executions: ExecutionStore, execution_ids: list[str], caller_id: str, workflow_name: str
) -> None:
    """Every id, or none of them.

    A batch that ran the ids it recognised would act on a partial request and name which ids exist,
    the same oracle a 403 would be. One query, not one per id: ask for the intersection and compare
    sizes. This is the one ownership check the mounter cannot attach, because the ids arrive in the
    body.
    """
    owned = await executions.owned_ids(execution_ids=execution_ids, user_id=caller_id, workflow_name=workflow_name)
    if len(owned) != len(set(execution_ids)):
        raise HTTPException(status_code=404, detail=UNKNOWN_EXECUTION)


def _add_get_execution(mount: _Mount, name: str) -> None:
    async def get_execution(execution_id: str, commands: Commands) -> WorkflowExecution:
        return WorkflowExecution.from_sdk(await commands.get_execution(execution_id))

    mount(
        "get_execution",
        "GET",
        "/executions/{execution_id}",
        get_execution,
        summary="Read one execution",
    )


def _add_execution_history(mount: _Mount, name: str) -> None:
    async def execution_history(
        execution_id: str,
        commands: Commands,
        decode_payloads: bool | None = None,
    ) -> ExecutionHistory:
        return ExecutionHistory.from_sdk(
            await commands.get_execution_history(execution_id, decode_payloads=decode_payloads)
        )

    mount(
        "execution_history",
        "GET",
        "/executions/{execution_id}/history",
        execution_history,
        summary="Read an execution's event history",
    )


def _add_execution_stream(mount: _Mount, name: str, stream_events: EventMapper | None) -> None:
    async def execution_stream(
        execution_id: str,
        stream_execution: Stream,
        cursor: str | None = None,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> StreamingResponse:
        # Read the header FIRST: `Last-Event-ID` is where an SSE client puts its resume cursor, and
        # the browser's own EventSource sends only that on an automatic reconnect. Without it a
        # dropped connection reopens at the platform default and re-delivers everything the client
        # already has. The query `cursor` is a fallback for a caller that cannot set the header.
        resume = last_event_id or cursor
        # Nothing that can refuse this request may run past this point: once
        # `event_stream_response` returns, the status line is committed and an exception can no
        # longer become a 404. The ownership check is a route dependency for exactly that reason —
        # it resolves before this body is entered at all.
        return event_stream_response(_execution_events(stream_execution, execution_id, stream_events, resume))

    mount(
        "execution_stream",
        "GET",
        "/executions/{execution_id}/stream",
        execution_stream,
        response_class=StreamingResponse,
        response_model=None,
        responses=_SSE,
        summary="Re-attach to an execution's event stream",
    )


async def _execution_events(
    stream_execution: StreamExecution, execution_id: str, stream_events: EventMapper | None, last_event_id: str | None
) -> AsyncIterator[str]:
    """``execution`` first, then whatever the mapper keeps, then ``error`` if the stream broke."""
    yield format_sse(event="execution", event_id=execution_id, data=ExecutionEvent(execution_id=execution_id))
    # HYBRID, not the platform's LIVE default. Creating an execution and streaming it are two
    # requests now, and everything the workflow emitted in between would be lost to a stream
    # that only starts at the connection. `last_event_id` narrows WHERE the replay begins on a
    # resume; HYBRID is what keeps a still-running execution's live tail following after it.
    frames = stream_execution(execution_id, event_source="HYBRID", last_event_id=last_event_id)
    # Each emitted event carries the resume id of the raw frame it was mapped from, so the browser
    # echoes it as `Last-Event-ID` on reconnect. The cursor is tapped outside the mapper (see
    # `_tap_frame_id`) because the id belongs to the transport frame, not the mapped event, so the
    # `EventMapper` contract stays `(event, payload)`.
    cursor: dict[str, str | None] = {"id": None}
    try:
        async for event, payload in (stream_events or _raw_events)(_tap_frame_id(frames, cursor)):
            yield format_sse(event=event, data=payload, event_id=cursor["id"])
    except Exception as error:
        yield format_sse(event="error", data=StreamError(message=str(error)))


async def _tap_frame_id(frames: AsyncIterator[Any], cursor: dict[str, str | None]) -> AsyncIterator[Any]:
    """Forward frames unchanged, recording each frame's resume id into ``cursor`` as it passes.

    ``cursor["id"]`` holds the id of the most recent frame the mapper has consumed, which is the
    correct resume point even for a mapper that buffers several frames before emitting one. A frame
    with no id leaves the cursor unchanged, so no ``id:`` line is emitted for it.
    """
    async for raw in frames:
        frame_id = raw.get("id") if isinstance(raw, dict) else getattr(raw, "id", None)
        if frame_id is not None:
            cursor["id"] = frame_id
        yield raw


async def _raw_events(frames: AsyncIterator[Any]) -> AsyncIterator[tuple[str, Any]]:
    """The default mapping: forward the platform's own frame, unnamed frames included."""
    async for raw in frames:
        payload = raw.model_dump(mode="json") if isinstance(raw, BaseModel) else raw
        if not isinstance(payload, dict):
            yield "event", payload
        else:
            yield str(payload.get("event") or "event"), payload.get("data", payload)


def _add_execution_cancel(mount: _Mount, name: str) -> None:
    async def execution_cancel(execution_id: str, cancel_execution: Cancel) -> CancelAccepted:
        await cancel_execution(execution_id)
        return CancelAccepted(execution_id=execution_id)

    mount(
        "execution_cancel",
        "POST",
        "/executions/{execution_id}/cancel",
        execution_cancel,
        status_code=202,
        summary="Stop an in-flight execution",
    )


def _add_execution_terminate(mount: _Mount, name: str) -> None:
    async def execution_terminate(execution_id: str, commands: Commands) -> TerminateAccepted:
        await commands.terminate_execution(execution_id)
        return TerminateAccepted(execution_id=execution_id)

    mount(
        "execution_terminate",
        "POST",
        "/executions/{execution_id}/terminate",
        execution_terminate,
        status_code=202,
        summary="Terminate an execution without letting it clean up",
    )


def _add_execution_reset(mount: _Mount, name: str) -> None:
    async def execution_reset(execution_id: str, body: ResetRequest, commands: Commands) -> ResetAccepted:
        await commands.reset_execution(
            execution_id,
            event_id=body.event_id,
            reason=body.reason,
            exclude_signals=body.exclude_signals,
            exclude_updates=body.exclude_updates,
        )
        return ResetAccepted(execution_id=execution_id)

    mount(
        "execution_reset",
        "POST",
        "/executions/{execution_id}/reset",
        execution_reset,
        status_code=202,
        summary="Rewind an execution to an earlier event",
    )


def _add_execution_signal(mount: _Mount, name: str) -> None:
    async def execution_signal(execution_id: str, body: SignalRequest, commands: Commands) -> SignalAccepted:
        return SignalAccepted.from_sdk(await commands.signal_execution(execution_id, name=body.name, input=body.input))

    mount(
        "execution_signal",
        "POST",
        "/executions/{execution_id}/signals",
        execution_signal,
        status_code=202,
        summary="Send a signal to an execution",
    )


def _add_execution_query(mount: _Mount, name: str) -> None:
    async def execution_query(execution_id: str, body: QueryRequest, commands: Commands) -> QueryResult:
        return QueryResult.from_sdk(await commands.query_execution(execution_id, name=body.name, input=body.input))

    mount(
        "execution_query",
        "POST",
        "/executions/{execution_id}/queries",
        execution_query,
        summary="Query an execution's state",
    )


def _add_execution_update(mount: _Mount, name: str) -> None:
    async def execution_update(execution_id: str, body: UpdateRequest, commands: Commands) -> UpdateResult:
        return UpdateResult.from_sdk(await commands.update_execution(execution_id, name=body.name, input=body.input))

    mount(
        "execution_update",
        "POST",
        "/executions/{execution_id}/updates",
        execution_update,
        summary="Send an update to an execution and wait for its result",
    )


def _add_execution_logs(mount: _Mount, name: str) -> None:
    async def execution_logs(
        execution_id: str,
        commands: Commands,
        run_id: str | None = None,
        activity_id: str | None = None,
        after: datetime | None = None,
        before: datetime | None = None,
        order: Annotated[Literal["asc", "desc"] | None, Query()] = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> ExecutionLogPage:
        return ExecutionLogPage.from_sdk(
            await commands.get_execution_logs(
                execution_id,
                run_id=run_id,
                activity_id=activity_id,
                after=after,
                before=before,
                order=order,
                cursor=cursor,
                limit=limit,
            )
        )

    mount(
        "execution_logs",
        "GET",
        "/executions/{execution_id}/logs",
        execution_logs,
        summary="Search an execution's logs",
    )


def _add_execution_logs_stream(mount: _Mount, name: str) -> None:
    async def execution_logs_stream(
        execution_id: str,
        commands: Commands,
        run_id: str | None = None,
        activity_id: str | None = None,
        after: datetime | None = None,
    ) -> StreamingResponse:
        return event_stream_response(
            _log_events(commands, execution_id, run_id=run_id, activity_id=activity_id, after=after)
        )

    mount(
        "execution_logs_stream",
        "GET",
        "/executions/{execution_id}/logs/stream",
        execution_logs_stream,
        response_class=StreamingResponse,
        response_model=None,
        responses=_SSE,
        summary="Follow an execution's logs",
    )


async def _log_events(
    commands: ExecutionCommands,
    execution_id: str,
    *,
    run_id: str | None,
    activity_id: str | None,
    after: datetime | None,
) -> AsyncIterator[str]:
    """A vocabulary of its own: ``execution``, ``log``, ``error``.

    Log lines are not workflow events and must not use a workflow event mapper. A mapper keyed on
    lifecycle frame names would drop every line it did not recognise, which is all of them.
    """
    yield format_sse(event="execution", event_id=execution_id, data=ExecutionEvent(execution_id=execution_id))
    try:
        async for record in commands.stream_execution_logs(
            execution_id, run_id=run_id, activity_id=activity_id, after=after
        ):
            yield format_sse(event="log", data=record)
    except Exception as error:
        yield format_sse(event="error", data=StreamError(message=str(error)))


def _add_execution_trace_info(mount: _Mount, name: str) -> None:
    async def execution_trace_info(execution_id: str, commands: Commands) -> TraceInfo:
        return TraceInfo.from_sdk(await commands.get_execution_trace_info(execution_id))

    mount(
        "execution_trace_info",
        "GET",
        "/executions/{execution_id}/trace/info",
        execution_trace_info,
        summary="Whether an execution has trace data, and under which id",
    )


def _add_execution_trace_otel(mount: _Mount, name: str) -> None:
    async def execution_trace_otel(execution_id: str, commands: Commands) -> ExecutionDiagnostics:
        return ExecutionDiagnostics.from_otel(await commands.get_execution_trace_otel(execution_id))

    mount(
        "execution_trace_otel",
        "GET",
        "/executions/{execution_id}/trace/otel",
        execution_trace_otel,
        summary="An execution's OpenTelemetry trace",
    )


def _add_execution_trace_summary(mount: _Mount, name: str) -> None:
    async def execution_trace_summary(execution_id: str, commands: Commands) -> ExecutionDiagnostics:
        return ExecutionDiagnostics.from_summary(await commands.get_execution_trace_summary(execution_id))

    mount(
        "execution_trace_summary",
        "GET",
        "/executions/{execution_id}/trace/summary",
        execution_trace_summary,
        summary="An execution's span tree",
    )


def _add_execution_trace_events(mount: _Mount, name: str) -> None:
    async def execution_trace_events(
        execution_id: str,
        commands: Commands,
        merge_same_id_events: bool = False,
        include_internal_events: bool = False,
    ) -> ExecutionDiagnostics:
        return ExecutionDiagnostics.from_events(
            await commands.get_execution_trace_events(
                execution_id,
                merge_same_id_events=merge_same_id_events,
                include_internal_events=include_internal_events,
            )
        )

    mount(
        "execution_trace_events",
        "GET",
        "/executions/{execution_id}/trace/events",
        execution_trace_events,
        summary="An execution's trace events",
    )
