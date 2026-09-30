"""What `WorkflowRouter` promises: the shape of the surface, and who is allowed to reach it."""

from typing import Any, Self

import httpx
import mistralai.workflows as workflows
import pytest
from mistralai_capabilities.workflows.client import MistralError
from fakes import (
    FakeCancel,
    FakeExecutionCommands,
    FakeExecutionStore,
    FakeStart,
    FakeStream,
    user,
)
from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError
from mistralai_capabilities.fastapi_auth.identity.gate import require_user
from mistralai_capabilities.fastapi_workflows_auth import commands as execution_commands
from mistralai_capabilities.fastapi_workflows_auth import ownership
from mistralai_capabilities.fastapi_workflows_auth import router as workflow_router
from mistralai_capabilities.fastapi_workflows_auth.router import (
    ALL_OPERATIONS,
    CreateRefusal,
    Operation,
    WorkflowRouteConfigurationError,
    WorkflowRouter,
)
from mistralai_capabilities.fastapi_workflows_auth.schemas import WorkflowExecution
from worker.workflows.agents import AgentsSessionWorkflow
from worker.workflows.speech import SpeechTranscribeWorkflow

OWNER = "caller-1"
EXECUTION = "exec-1"


class EchoInput(BaseModel):
    message: str


class EchoOutput(BaseModel):
    echoed: str


class WireRequest(BaseModel):
    prompt: str


class AgentRunInput(BaseModel):
    """A stand-in for what a session workflow is started with.

    Mounting ``AgentsSessionWorkflow`` behind a bespoke wire contract needs an explicit
    ``request_model`` and an ``input_adapter`` to convert the wire body into the started input. The
    tests below use ``FakeStart``, which never validates the started input, so any model of this
    shape works.
    """

    message: str

    @classmethod
    def from_prompt(cls, prompt: str) -> Self:
        return cls(message=prompt)


@workflows.workflow.define(name="demo")
class CommandableWorkflow:
    """Declares one of each handler, so it derives the whole nineteen-route surface."""

    @workflows.workflow.entrypoint
    async def run(self, request: EchoInput) -> EchoOutput:
        return EchoOutput(echoed=request.message)

    @workflows.workflow.signal()
    async def nudge(self) -> None: ...

    @workflows.workflow.query()
    def progress(self) -> str:
        return "running"

    @workflows.workflow.update()
    async def revise(self) -> str:
        return "revised"


@workflows.workflow.define(name="routers_test_query_only")
class QueryOnlyWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: EchoInput) -> EchoOutput:
        return EchoOutput(echoed=request.message)

    @workflows.workflow.query()
    def progress(self) -> str:
        return "running"


class UnreflectableWorkflow:
    """No entrypoint marker at all, so `infer_workflow_models` cannot see a request model."""

    async def run(self, request: EchoInput) -> EchoOutput:
        return EchoOutput(echoed=request.message)


def _router(**overrides: Any) -> Any:
    options: dict[str, Any] = {"prefix": "/demo", "name": "demo"}
    options.update(overrides)
    return WorkflowRouter(CommandableWorkflow, **options)


def _paths(router: Any) -> set[str]:
    return {route.path for route in router.routes if isinstance(route, APIRoute)}


def _app(
    *routers: Any,
    start: FakeStart | None = None,
    stream: FakeStream | None = None,
    cancel: FakeCancel | None = None,
    commands: FakeExecutionCommands | None = None,
    executions: FakeExecutionStore | None = None,
) -> FastAPI:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    app.dependency_overrides[require_user] = lambda: user(OWNER)
    app.dependency_overrides[execution_commands._start] = lambda: start or FakeStart()
    app.dependency_overrides[execution_commands._stream] = lambda: stream or FakeStream()
    app.dependency_overrides[execution_commands._cancel] = lambda: cancel or FakeCancel()
    app.dependency_overrides[execution_commands._commands] = lambda: commands or FakeExecutionCommands()
    app.dependency_overrides[ownership._executions] = lambda: executions or FakeExecutionStore()
    return app


def _owned(*, workflow_name: str = "demo", execution_id: str = EXECUTION) -> FakeExecutionStore:
    return FakeExecutionStore({(execution_id, OWNER, workflow_name)})


class _ForgetfulCommands(FakeExecutionCommands):
    """A platform that 404s for one id, standing in for an ownership row that outlived its run."""

    def __init__(self, missing: str) -> None:
        super().__init__()
        self._missing = missing

    async def get_execution(self, execution_id: str) -> Any:
        if execution_id == self._missing:
            raise MistralError("no such execution", httpx.Response(404))
        return await super().get_execution(execution_id)


# --- construction -----------------------------------------------------------------------------


def test_the_request_model_is_inferred_from_the_entrypoint_by_default() -> None:
    """Inference is the default, so the common case declares nothing."""
    app = _app(_router())

    schema = app.openapi()["paths"]["/demo/executions"]["post"]["requestBody"]["content"]["application/json"]
    assert schema["schema"]["$ref"].endswith("/EchoInput")


def test_an_explicit_request_model_wins_and_skips_inference_entirely() -> None:
    """A declared ``request_model`` is used verbatim and skips inference entirely: mounting
    ``AgentsSessionWorkflow`` behind a bespoke wire contract never reflects its entrypoint."""
    router = WorkflowRouter(
        AgentsSessionWorkflow,
        prefix="/demo",
        name="demo",
        request_model=WireRequest,
        input_adapter=lambda body: AgentRunInput.from_prompt(body.prompt),
    )

    schema = _app(router).openapi()["paths"]["/demo/executions"]["post"]["requestBody"]["content"]["application/json"]
    assert schema["schema"]["$ref"].endswith("/WireRequest")


def test_an_input_adapter_without_a_request_model_is_a_construction_error() -> None:
    """They are a pair: inference cannot supply the wire type the adapter converts from."""
    with pytest.raises(WorkflowRouteConfigurationError, match="input_adapter= without request_model="):
        _router(input_adapter=lambda body: body)


def test_an_unreflectable_workflow_names_the_two_arguments_that_fix_it() -> None:
    with pytest.raises(WorkflowRouteConfigurationError) as failure:
        WorkflowRouter(UnreflectableWorkflow, prefix="/demo", name="demo")

    assert "request_model=" in str(failure.value)
    assert "input_adapter=" in str(failure.value)
    assert "has no workflow entrypoint" in str(failure.value)


def test_the_input_adapter_converts_the_wire_body_before_the_workflow_starts() -> None:
    start = FakeStart()
    router = WorkflowRouter(
        CommandableWorkflow,
        prefix="/demo",
        name="demo",
        request_model=WireRequest,
        input_adapter=lambda body: EchoInput(message=body.prompt),
    )

    with TestClient(_app(router, start=start)) as client:
        assert client.post("/demo/executions", json={"prompt": "hello"}).status_code == 202

    assert start.calls[0]["input"] == EchoInput(message="hello")


# --- the surface ------------------------------------------------------------------------------


def test_the_factory_emits_the_nineteen_route_command_surface() -> None:
    routes = [route for route in _router().routes if isinstance(route, APIRoute)]

    assert len(routes) == 19
    assert {(route.methods.pop(), route.path) for route in routes} == {
        ("POST", "/demo/executions"),
        ("GET", "/demo/executions"),
        ("POST", "/demo/executions/cancel"),
        ("POST", "/demo/executions/terminate"),
        ("GET", "/demo/executions/{execution_id}"),
        ("GET", "/demo/executions/{execution_id}/history"),
        ("GET", "/demo/executions/{execution_id}/stream"),
        ("POST", "/demo/executions/{execution_id}/cancel"),
        ("POST", "/demo/executions/{execution_id}/terminate"),
        ("POST", "/demo/executions/{execution_id}/reset"),
        ("POST", "/demo/executions/{execution_id}/signals"),
        ("POST", "/demo/executions/{execution_id}/queries"),
        ("POST", "/demo/executions/{execution_id}/updates"),
        ("GET", "/demo/executions/{execution_id}/logs"),
        ("GET", "/demo/executions/{execution_id}/logs/stream"),
        ("GET", "/demo/executions/{execution_id}/trace/info"),
        ("GET", "/demo/executions/{execution_id}/trace/otel"),
        ("GET", "/demo/executions/{execution_id}/trace/summary"),
        ("GET", "/demo/executions/{execution_id}/trace/events"),
    }


def test_every_operation_id_is_the_name_prefixed_operation() -> None:
    """Operation ids are the generated web client's function names and are drift-checked in CI."""
    routes = [route for route in _router().routes if isinstance(route, APIRoute)]

    assert {route.operation_id for route in routes} == {f"demo_{operation}" for operation in ALL_OPERATIONS}


# --- op-id namespace vs ownership identity (spec 0001) -------------------------------------------

# `CommandableWorkflow` is `@workflow.define(name="demo")`, so its catalog name is "demo" whatever
# op-id namespace a mount picks.


def test_op_ids_come_from_the_name_but_ownership_comes_from_the_workflow() -> None:
    """The op-id namespace is free to differ from the identity ownership is recorded under."""
    executions = FakeExecutionStore()
    router = WorkflowRouter(CommandableWorkflow, prefix="/demo", name="opid_v1")
    op_ids = {route.operation_id for route in router.routes if isinstance(route, APIRoute)}

    with TestClient(_app(router, start=FakeStart(), executions=executions)) as client:
        execution_id = client.post("/demo/executions", json={"message": "hello"}).json()["execution_id"]

    assert op_ids == {f"opid_v1_{operation}" for operation in ALL_OPERATIONS}
    assert executions.owned == {(execution_id, OWNER, "demo")}


def test_a_stale_op_id_name_does_not_leak_into_ownership_so_reads_resolve() -> None:
    """The RC-adoption regression: pinning a stale `name` for op-ids must not desync ownership.

    Ownership tracks the workflow's catalog name, so create and an id-addressed read agree and the
    run stays visible — the silent 404 cannot recur.
    """
    executions = FakeExecutionStore()
    router = WorkflowRouter(CommandableWorkflow, prefix="/demo", name="dau_document_extraction")

    with TestClient(_app(router, start=FakeStart(), executions=executions)) as client:
        execution_id = client.post("/demo/executions", json={"message": "hello"}).json()["execution_id"]
        read = client.get(f"/demo/executions/{execution_id}")

    assert executions.owned == {(execution_id, OWNER, "demo")}
    assert read.status_code == 200


def test_an_ownership_name_that_contradicts_the_workflow_fails_construction() -> None:
    """A wrong assertion is a boot-time error naming both values, not a per-run 404."""
    with pytest.raises(WorkflowRouteConfigurationError) as failure:
        WorkflowRouter(CommandableWorkflow, prefix="/demo", name="demo", ownership_name="stale")

    assert "stale" in str(failure.value)
    assert "demo" in str(failure.value)


def test_an_ownership_name_that_matches_the_workflow_constructs() -> None:
    router = WorkflowRouter(CommandableWorkflow, prefix="/demo", name="opid_v1", ownership_name="demo")

    assert _paths(router)


def test_a_class_with_no_workflow_definition_is_a_configuration_error() -> None:
    """`request_model=` + `operations=` bypass both reflection guards; the name lookup is the last one.

    It must stay inside the factory's error boundary rather than leaking the SDK's raw ValueError.
    """
    with pytest.raises(WorkflowRouteConfigurationError, match="no workflow definition"):
        WorkflowRouter(
            UnreflectableWorkflow,
            prefix="/demo",
            name="demo",
            request_model=WireRequest,
            operations=frozenset({"create_execution"}),
        )


def test_an_ownership_name_cannot_stand_in_for_a_missing_workflow_definition() -> None:
    """A class with no definition cannot be started either (start resolves it), so no name rescues it."""
    with pytest.raises(WorkflowRouteConfigurationError, match="no workflow definition"):
        WorkflowRouter(
            UnreflectableWorkflow,
            prefix="/demo",
            name="demo",
            ownership_name="explicit_owner",
            request_model=WireRequest,
            operations=frozenset({"create_execution"}),
        )


def test_the_batch_routes_are_registered_before_the_parameterised_one() -> None:
    """FastAPI matches in registration order; `/executions/{execution_id}` would swallow these."""
    paths = [route.path for route in _router().routes if isinstance(route, APIRoute)]

    assert paths.index("/demo/executions/cancel") < paths.index("/demo/executions/{execution_id}")
    assert paths.index("/demo/executions/terminate") < paths.index("/demo/executions/{execution_id}")


def test_the_batch_cancel_path_is_not_answered_as_an_execution_id() -> None:
    """The ordering above, proven against a live request rather than a list index."""
    commands = FakeExecutionCommands()
    app = _app(_router(), commands=commands, executions=_owned(execution_id="a"))

    with TestClient(app) as client:
        response = client.post("/demo/executions/cancel", json={"execution_ids": ["a"]})

    assert response.status_code == 200
    assert commands.operations == ["batch_cancel_executions"]


def test_operations_narrows_the_surface_without_touching_the_factory() -> None:
    narrowed: frozenset[Operation] = frozenset({"create_execution", "execution_stream", "execution_cancel"})
    routes = [route for route in _router(operations=narrowed).routes if isinstance(route, APIRoute)]

    assert {route.operation_id for route in routes} == {
        "demo_create_execution",
        "demo_execution_stream",
        "demo_execution_cancel",
    }


# --- deriving the surface from the workflow -----------------------------------------------------

_COMMAND_PATHS = {
    "/demo/executions/{execution_id}/signals",
    "/demo/executions/{execution_id}/queries",
    "/demo/executions/{execution_id}/updates",
}


def test_a_workflow_declaring_every_handler_derives_all_nineteen() -> None:
    assert _COMMAND_PATHS <= _paths(_router())


def test_a_workflow_with_no_public_handlers_publishes_no_command_routes() -> None:
    """A `/signals` route on a workflow with no signal handler is a 404 that a caller can find.

    `SpeechTranscribeWorkflow` declares no signal, query, or update, so none of the command routes
    that would 404 against it are published — while the id-addressed lifecycle routes still are.
    """
    paths = _paths(WorkflowRouter(SpeechTranscribeWorkflow, prefix="/demo", name="demo"))

    assert not paths & _COMMAND_PATHS
    assert {
        "/demo/executions",
        "/demo/executions/{execution_id}",
        "/demo/executions/{execution_id}/stream",
        "/demo/executions/{execution_id}/cancel",
    } <= paths


def test_one_declared_query_derives_the_query_route_and_nothing_else() -> None:
    paths = _paths(WorkflowRouter(QueryOnlyWorkflow, prefix="/demo", name="demo"))

    assert paths & _COMMAND_PATHS == {"/demo/executions/{execution_id}/queries"}


def test_an_explicit_set_overrides_the_derived_one_in_both_directions() -> None:
    """It may add what the workflow does not declare, and drop what it does."""
    added: frozenset[Operation] = frozenset({"execution_signal"})
    dropped: frozenset[Operation] = frozenset({"get_execution"})

    assert _paths(WorkflowRouter(SpeechTranscribeWorkflow, prefix="/demo", name="demo", operations=added)) == {
        "/demo/executions/{execution_id}/signals"
    }
    assert _paths(WorkflowRouter(CommandableWorkflow, prefix="/demo", name="demo", operations=dropped)) == {
        "/demo/executions/{execution_id}"
    }


def test_an_operation_the_factory_does_not_build_is_rejected_at_construction() -> None:
    """A typo would otherwise silently drop a route instead of failing the mount."""
    with pytest.raises(WorkflowRouteConfigurationError, match="Unknown operations"):
        _router(operations=frozenset({"execution_delete"}))


def test_deriving_from_a_class_that_is_not_a_workflow_names_operations_as_the_fix() -> None:
    with pytest.raises(WorkflowRouteConfigurationError, match=r"Pass operations="):
        WorkflowRouter(UnreflectableWorkflow, prefix="/demo", name="demo", request_model=WireRequest)


def test_tags_reach_the_generated_document() -> None:
    app = _app(_router(tags=["demo"]))

    assert app.openapi()["paths"]["/demo/executions"]["post"]["tags"] == ["demo"]


def test_the_module_exposes_no_router_so_discovery_skips_it() -> None:
    """A factory is not a mount; `routers.v1` decides where — and whether — this is served."""
    assert not hasattr(workflow_router, "router")


# --- the shared-closure trap ---------------------------------------------------------------


def test_two_routers_from_one_factory_mount_together_on_one_app() -> None:
    """The reason every endpoint's `__name__` and dynamic annotations are set explicitly.

    Each closure gets a placeholder annotation, and the per-mount model is substituted onto
    `__annotations__`, because the real type is a factory parameter that FastAPI cannot resolve
    from `fn.__globals__`. `route.name` also defaults to `__name__`, the same closure name for both
    mounts, so `url_path_for` would be ambiguous without the substitution.
    """
    first = WorkflowRouter(CommandableWorkflow, prefix="/first", name="first")
    second = WorkflowRouter(
        CommandableWorkflow,
        prefix="/second",
        name="second",
        request_model=WireRequest,
        input_adapter=lambda body: EchoInput(message=body.prompt),
    )
    app = _app(first, second)

    # Read from the module routers, not `app.routes`: FastAPI defers `include_router`, so the app
    # holds no `APIRoute` to inspect until the document is built. Building it proves both mounted.
    # 18 paths per mount, not 19: create and list share `/executions` under different methods.
    assert len(app.openapi()["paths"]) == 36, "the two prefixes must not collide"
    mounted = [route for router in (first, second) for route in router.routes if isinstance(route, APIRoute)]

    assert len({route.operation_id for route in mounted}) == 38
    assert len({route.name for route in mounted}) == 38
    assert app.url_path_for("first_execution_cancel", execution_id="x") == "/first/executions/x/cancel"
    assert app.url_path_for("second_execution_cancel", execution_id="x") == "/second/executions/x/cancel"


def test_each_mount_keeps_its_own_request_model() -> None:
    """A shared closure that leaked one factory's `body_model` into the other would pass above."""
    first = WorkflowRouter(CommandableWorkflow, prefix="/first", name="first")
    second = WorkflowRouter(
        CommandableWorkflow,
        prefix="/second",
        name="second",
        request_model=WireRequest,
        input_adapter=lambda body: EchoInput(message=body.prompt),
    )
    paths = _app(first, second).openapi()["paths"]

    def body_ref(path: str) -> str:
        return paths[path]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"]

    assert body_ref("/first/executions").endswith("/EchoInput")
    assert body_ref("/second/executions").endswith("/WireRequest")


# --- create -----------------------------------------------------------------------------------


def test_create_records_ownership_and_answers_202_with_the_execution() -> None:
    start = FakeStart()
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert response.status_code == 202
    assert executions.owned == {(response.json()["execution_id"], OWNER, "demo")}
    assert start.calls[0]["wait_for_result"] is False


def test_ownership_is_recorded_before_the_workflow_is_started() -> None:
    """The whole point of the ordering: no instant exists in which a live execution is unowned."""
    executions = FakeExecutionStore()
    observed: list[set[tuple[str, str, str]]] = []

    class ObservingStart(FakeStart):
        async def __call__(self, *args: Any, **kwargs: Any) -> Any:
            observed.append(set(executions.owned))
            return await super().__call__(*args, **kwargs)

    with TestClient(_app(_router(), start=ObservingStart(), executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert observed == [{(response.json()["execution_id"], OWNER, "demo")}], (
        "the ownership row must already be in the store at the moment start is invoked"
    )


def test_the_workflow_is_started_under_the_id_ownership_was_recorded_for() -> None:
    """A row for one id and an execution under another would authorise nothing that exists."""
    start = FakeStart()
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    execution_id = response.json()["execution_id"]
    assert start.calls[0]["execution_id"] == execution_id
    assert executions.owned == {(execution_id, OWNER, "demo")}


class RecordingHook:
    """An ``on_create`` that remembers what it was handed, and whether it let the create through."""

    def __init__(self, *, admit: bool = True) -> None:
        self.admit = admit
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, *, execution_id: str, body: Any, user_id: str) -> bool:
        self.calls.append({"execution_id": execution_id, "body": body, "user_id": user_id})
        return self.admit


def test_the_create_hook_sees_the_minted_id_the_body_and_the_caller() -> None:
    hook = RecordingHook()
    start = FakeStart()

    with TestClient(_app(_router(on_create=hook), start=start)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    execution_id = response.json()["execution_id"]
    assert hook.calls == [{"execution_id": execution_id, "body": EchoInput(message="hello"), "user_id": OWNER}]


def test_the_create_hook_runs_after_the_ownership_row_and_before_the_start() -> None:
    """Record, hook, start. The hook's row is read by an execution that has not begun yet."""
    executions = FakeExecutionStore()
    order: list[str] = []

    class OrderedHook(RecordingHook):
        async def __call__(self, **kwargs: Any) -> bool:
            order.append(f"hook:{len(executions.owned)}")
            return await super().__call__(**kwargs)

    class OrderedStart(FakeStart):
        async def __call__(self, *args: Any, **kwargs: Any) -> Any:
            order.append("start")
            return await super().__call__(*args, **kwargs)

    with TestClient(_app(_router(on_create=OrderedHook()), start=OrderedStart(), executions=executions)) as client:
        client.post("/demo/executions", json={"message": "hello"})

    assert order == ["hook:1", "start"]


def test_a_refusing_create_hook_answers_404_and_starts_nothing() -> None:
    """Refusal is 404 and not 403, and it must happen before anything is running."""
    hook = RecordingHook(admit=False)
    start = FakeStart()

    with TestClient(_app(_router(on_create=hook), start=start)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown execution"}
    assert start.calls == [], "a refused create must leave no workflow running"


def test_a_typed_refusal_answers_its_named_status_and_starts_nothing() -> None:
    """A hook that must refuse as something other than not-found returns a CreateRefusal.

    The router builds the response from it, so the status code lives here and not in the
    feature-layer hook. Like a bool refusal, the claim is withdrawn and nothing starts.
    """

    class RefusingHook:
        async def __call__(self, *, execution_id: str, body: Any, user_id: str) -> CreateRefusal:
            return CreateRefusal(status_code=422, detail="nope")

    executions = FakeExecutionStore()
    start = FakeStart()

    with TestClient(_app(_router(on_create=RefusingHook()), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert response.status_code == 422
    assert response.json() == {"detail": "nope"}
    assert start.calls == [], "a refused create must leave no workflow running"
    assert executions.owned == set(), "the claim is withdrawn on refusal"


@pytest.mark.parametrize("status_code", [200, 302, 399, 600])
def test_a_typed_refusal_requires_an_error_status(status_code: int) -> None:
    """A refusal cannot masquerade as a successful create."""

    with pytest.raises(ValidationError):
        CreateRefusal(status_code=status_code, detail="nope")


def test_a_mount_with_no_create_hook_is_untouched() -> None:
    """The seam is opt-in: speech passes nothing and must not gain a 404 it cannot produce."""
    start = FakeStart()

    with TestClient(_app(_router(), start=start)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert response.status_code == 202
    assert len(start.calls) == 1
    assert "404" not in _create_responses(_router())


def test_only_a_mount_with_a_create_hook_publishes_the_404() -> None:
    assert "404" in _create_responses(_router(on_create=RecordingHook()))


def _create_responses(router: Any) -> dict[str, Any]:
    app = FastAPI()
    app.include_router(router)
    return dict(app.openapi()["paths"]["/demo/executions"]["post"]["responses"])


def test_waiting_for_the_result_answers_200_with_the_workflow_output() -> None:
    start = FakeStart(result={"echoed": "hello"})

    with TestClient(_app(_router(wait_for_result=True), start=start)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert response.status_code == 200
    assert response.json() == {"echoed": "hello"}
    assert start.calls[0]["wait_for_result"] is True


def test_the_inferred_return_type_becomes_the_waited_response_model() -> None:
    app = _app(_router(wait_for_result=True))

    responses = app.openapi()["paths"]["/demo/executions"]["post"]["responses"]
    assert responses["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/EchoOutput")


def test_the_waited_route_is_the_endpoint_the_annotations_were_substituted_onto() -> None:
    """Two create closures exist and only the mounted one is substituted. Mounting the other
    publishes the un-substituted `body: BaseModel` placeholder, an empty request schema in the
    speech mounts' generated client. The body ref tells the two apart from the outside.
    """
    app = _app(_router(wait_for_result=True))

    schema = app.openapi()["paths"]["/demo/executions"]["post"]["requestBody"]["content"]["application/json"]
    assert schema["schema"]["$ref"].endswith("/EchoInput")


# --- listing ----------------------------------------------------------------------------------


def test_listing_reads_the_ownership_table_and_not_the_platform_filter() -> None:
    """The caller and the workflow are the authorization boundary, and only this table knows them.

    The platform cannot be asked which executions are the caller's, because a start request carries
    no end-user id. It is asked only to describe ids the table already vouched for. A
    caller-supplied `user_id` must not reach either side.
    """
    executions = _owned(execution_id="mine")

    with TestClient(_app(_router(), executions=executions)) as client:
        response = client.get("/demo/executions", params={"user_id": "someone-else", "workflow_name": "other"})

    assert response.status_code == 200
    assert [call["user_id"] for call in executions.list_calls] == [OWNER]
    assert [call["workflow_name"] for call in executions.list_calls] == ["demo"]
    assert response.json()["executions"][0]["execution_id"] == "mine"


def test_a_listing_shows_only_the_callers_own_executions() -> None:
    """The regression the whole change exists for: another caller's execution is not listed."""
    executions = FakeExecutionStore({("mine", OWNER, "demo"), ("theirs", "someone-else", "demo")})

    with TestClient(_app(_router(), executions=executions)) as client:
        page = client.get("/demo/executions").json()

    assert [execution["execution_id"] for execution in page["executions"]] == ["mine"]


def test_a_listing_does_not_cross_workflows() -> None:
    executions = FakeExecutionStore({("mine", OWNER, "demo"), ("elsewhere", OWNER, "other")})

    with TestClient(_app(_router(), executions=executions)) as client:
        page = client.get("/demo/executions").json()

    assert [execution["execution_id"] for execution in page["executions"]] == ["mine"]


def test_listing_exposes_only_the_five_agreed_filters() -> None:
    app = _app(_router())

    parameters = app.openapi()["paths"]["/demo/executions"]["get"]["parameters"]
    assert {parameter["name"] for parameter in parameters} == {
        "status",
        "start_time_after",
        "start_time_before",
        "page_size",
        "next_page_token",
    }


def test_a_listed_execution_carries_no_result() -> None:
    """A page describes executions; inlining fifty results would make it fifty payloads."""
    with TestClient(_app(_router(), executions=_owned(execution_id="mine"))) as client:
        page = client.get("/demo/executions").json()

    assert page["executions"][0]["execution_id"] == "mine"
    assert page["executions"][0]["result"] is None


def test_a_listing_carries_the_recorded_outcome_and_none_when_unsettled() -> None:
    """The badge the platform status cannot express: an approved run reads `completed` there.

    A settled run badge is read from the ownership store in one batch with the page, so the list
    shows Approved/Rejected without a per-row workflow query. A still-open run is null.
    """
    executions = FakeExecutionStore({("settled", OWNER, "demo"), ("open", OWNER, "demo")})
    executions.outcomes_by_owner[("settled", OWNER)] = "approved"

    with TestClient(_app(_router(), executions=executions)) as client:
        page = client.get("/demo/executions").json()

    badges = {execution["execution_id"]: execution["outcome"] for execution in page["executions"]}
    assert badges == {"settled": "approved", "open": None}


def test_a_listing_does_not_leak_another_callers_outcome() -> None:
    """The batch read is owner-scoped, so an outcome recorded under another caller never appears."""
    executions = _owned(execution_id="mine")
    executions.outcomes_by_owner[("mine", "someone-else")] = "approved"

    with TestClient(_app(_router(), executions=executions)) as client:
        page = client.get("/demo/executions").json()

    assert page["executions"][0]["outcome"] is None


def test_a_page_carries_a_cursor_only_when_it_filled() -> None:
    """The cursor is the last id of the page, and its absence is what ends the listing."""
    executions = FakeExecutionStore({(f"exec-{index}", OWNER, "demo") for index in range(3)})

    with TestClient(_app(_router(), executions=executions)) as client:
        full = client.get("/demo/executions", params={"page_size": 2}).json()
        short = client.get("/demo/executions", params={"page_size": 50}).json()

    assert full["next_page_token"] == full["executions"][-1]["execution_id"]
    assert short["next_page_token"] is None


def test_paging_walks_every_execution_exactly_once() -> None:
    executions = FakeExecutionStore({(f"exec-{index}", OWNER, "demo") for index in range(5)})

    seen: list[str] = []
    cursor: str | None = None
    with TestClient(_app(_router(), executions=executions)) as client:
        while True:
            params: dict[str, Any] = {"page_size": 2}
            if cursor is not None:
                params["next_page_token"] = cursor
            page = client.get("/demo/executions", params=params).json()
            seen.extend(execution["execution_id"] for execution in page["executions"])
            cursor = page["next_page_token"]
            if cursor is None:
                break

    assert sorted(seen) == [f"exec-{index}" for index in range(5)]
    assert len(seen) == len(set(seen))


def test_a_page_token_belonging_to_someone_else_pages_nothing() -> None:
    """A foreign cursor is indistinguishable from an exhausted one, so paging is no oracle."""
    executions = FakeExecutionStore({("mine", OWNER, "demo"), ("theirs", "someone-else", "demo")})

    with TestClient(_app(_router(), executions=executions)) as client:
        page = client.get("/demo/executions", params={"next_page_token": "theirs"}).json()

    assert page["executions"] == []


def test_an_owned_execution_the_platform_forgot_is_skipped_rather_than_a_500() -> None:
    """An ownership row can outlive its execution, and one such row must not break the listing."""
    executions = FakeExecutionStore({("gone", OWNER, "demo"), ("mine", OWNER, "demo")})

    with TestClient(_app(_router(), commands=_ForgetfulCommands("gone"), executions=executions)) as client:
        response = client.get("/demo/executions")

    assert response.status_code == 200
    assert [execution["execution_id"] for execution in response.json()["executions"]] == ["mine"]


def test_the_listing_page_size_is_capped() -> None:
    """The page is hydrated one platform read per id, so the query string cannot set the fan-out."""
    executions = _owned(execution_id="mine")

    with TestClient(_app(_router(), executions=executions)) as client:
        client.get("/demo/executions", params={"page_size": 10_000})

    assert executions.list_calls[0]["limit"] == 100


# --- an ownership row that outlived its execution ------------------------------------------------


def test_an_owned_id_the_platform_has_forgotten_answers_404_not_500() -> None:
    """The row outlived the execution, so the resource really is gone — 404 is the honest answer."""
    app = _app(_router(), commands=_ForgetfulCommands(EXECUTION), executions=_owned())

    with TestClient(app) as client:
        response = client.get(f"/demo/executions/{EXECUTION}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown execution"}


def test_the_withdrawn_execution_is_indistinguishable_from_one_that_was_never_yours() -> None:
    """Re-mapping the platform's 404 must not open a narrower oracle beside the ownership one."""
    forgotten = _app(_router(), commands=_ForgetfulCommands(EXECUTION), executions=_owned())
    foreign = _app(_router(), executions=FakeExecutionStore())

    with TestClient(forgotten) as client:
        mine = client.get(f"/demo/executions/{EXECUTION}")
    with TestClient(foreign) as client:
        theirs = client.get(f"/demo/executions/{EXECUTION}")

    assert (mine.status_code, mine.json()) == (theirs.status_code, theirs.json())


def test_a_platform_404_from_another_router_is_not_relabeled_an_unknown_execution() -> None:
    """The remap is this router's, not the app's.

    `MistralError` is raised by multiple SDK operations. An app-wide handler would relabel a
    404 from any of them, such as a prompt lookup or an MCP tool, as an unknown execution. That
    would invent a 404 where the caller previously got an honest 500.
    """
    elsewhere = APIRouter()

    @elsewhere.get("/registry/lookup")
    async def _lookup() -> dict[str, str]:
        raise MistralError("no such prompt", httpx.Response(404))

    app = _app(_router(), executions=_owned())
    app.include_router(elsewhere)

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/registry/lookup")

    assert response.status_code == 500, "a non-execution 404 must not borrow this surface's meaning"
    assert "Unknown execution" not in response.text


def test_a_create_is_not_covered_by_the_remap() -> None:
    """Only an id-addressed route has had ownership confirmed, so only it may reinterpret a 404."""

    class _Refusing(FakeStart):
        async def __call__(self, *args: Any, **kwargs: Any) -> Any:
            raise MistralError("workflow not registered", httpx.Response(404))

    app = _app(_router(), start=_Refusing(), executions=FakeExecutionStore())

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/demo/executions", json={"message": "hi"})

    assert response.status_code == 500, "an unregistered workflow is not an unknown execution"


def test_a_platform_fault_that_is_not_a_404_still_surfaces_as_a_fault() -> None:
    """Flattening every MistralError into 404 would hide an outage behind an empty-looking API."""

    class _Unavailable(FakeExecutionCommands):
        async def get_execution(self, execution_id: str) -> Any:
            raise MistralError("upstream is down", httpx.Response(503))

    app = _app(_router(), commands=_Unavailable(), executions=_owned())

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get(f"/demo/executions/{EXECUTION}")

    assert response.status_code == 500, "a 503 from the platform is not an unknown execution"


# --- ownership --------------------------------------------------------------------------------

# Derived from the router, not listed by hand. A hand-maintained list has the same failure mode as
# the check it guards: a new id-addressed route that skipped the ownership check would also be
# missing from the list, and the suite would stay green. Reading the mounted routes means a route
# cannot be published without landing in every ownership test below.
_BODIES: dict[str, dict[str, Any]] = {
    "/demo/executions/{execution_id}/reset": {"event_id": 3},
    "/demo/executions/{execution_id}/signals": {"name": "wake"},
    "/demo/executions/{execution_id}/queries": {"name": "state"},
    "/demo/executions/{execution_id}/updates": {"name": "patch"},
}

ITEM_ROUTES: list[tuple[str, str, dict[str, Any] | None]] = sorted(
    (next(iter(route.methods)), route.path, _BODIES.get(route.path))
    for route in _router().routes
    if isinstance(route, APIRoute) and "{execution_id}" in route.path
)


def test_every_id_addressed_route_is_covered_by_the_ownership_tests() -> None:
    """The derivation is only a safety net if it actually found the routes."""
    assert len(ITEM_ROUTES) == 15


@pytest.mark.parametrize(("method", "template", "body"), ITEM_ROUTES)
def test_an_unowned_execution_is_unknown_rather_than_forbidden(
    method: str, template: str, body: dict[str, Any] | None
) -> None:
    """404, never 403: a 403 would confirm the id exists to whoever guessed it."""
    commands = FakeExecutionCommands()
    app = _app(_router(), commands=commands, executions=FakeExecutionStore())

    with TestClient(app) as client:
        response = client.request(method, template.format(execution_id=EXECUTION), json=body)

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown execution"}
    assert commands.operations == [], "the platform must not be reached for an execution we refuse"


@pytest.mark.parametrize(("method", "template", "body"), ITEM_ROUTES)
def test_an_owner_reaches_every_id_addressed_route(method: str, template: str, body: dict[str, Any] | None) -> None:
    app = _app(_router(), executions=_owned())

    with TestClient(app) as client:
        response = client.request(method, template.format(execution_id=EXECUTION), json=body)

    assert response.status_code in {200, 202}


@pytest.mark.parametrize(("method", "template", "body"), ITEM_ROUTES)
def test_an_id_owned_under_another_workflow_does_not_answer_here(
    method: str, template: str, body: dict[str, Any] | None
) -> None:
    """The discriminator earns its place: without it one workflow's ids address another's routes."""
    app = _app(_router(), executions=_owned(workflow_name="other"))

    with TestClient(app) as client:
        response = client.request(method, template.format(execution_id=EXECUTION), json=body)

    assert response.status_code == 404


def test_a_batch_asks_the_store_once_rather_than_once_per_id() -> None:
    """A hundred-id batch was a hundred sequential round trips; the answer is one set."""
    executions = FakeExecutionStore({(f"exec-{index}", OWNER, "demo") for index in range(4)})
    asked: list[int] = []
    original = executions.owned_ids

    async def counting(**kwargs: Any) -> set[str]:
        asked.append(len(kwargs["execution_ids"]))
        return await original(**kwargs)

    executions.owned_ids = counting  # type: ignore[method-assign]

    with TestClient(_app(_router(), executions=executions)) as client:
        response = client.post(
            "/demo/executions/cancel", json={"execution_ids": [f"exec-{index}" for index in range(4)]}
        )

    assert response.status_code == 200
    assert asked == [4], "one question covering every id"


@pytest.mark.parametrize("path", ["/demo/executions/cancel", "/demo/executions/terminate"])
def test_a_batch_refuses_entirely_on_the_first_unknown_id(path: str) -> None:
    """Never partial-succeed, and never report which of the ids was the unknown one."""
    commands = FakeExecutionCommands()
    app = _app(_router(), commands=commands, executions=_owned(execution_id="mine"))

    with TestClient(app) as client:
        response = client.post(path, json={"execution_ids": ["mine", "theirs"]})

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown execution"}
    assert commands.operations == []


# --- streaming --------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/demo/executions/exec-1/stream", "/demo/executions/exec-1/logs/stream"])
def test_a_stream_refuses_before_the_response_begins(path: str) -> None:
    """A check inside the generator would arrive after the status line and could never be a 404."""
    with TestClient(_app(_router(), executions=FakeExecutionStore())) as client:
        response = client.get(path)

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")


def test_the_execution_stream_opens_with_the_execution_frame() -> None:
    with TestClient(_app(_router(), executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/stream").text

    assert body.startswith('event: execution\nid: exec-1\ndata: {"execution_id":"exec-1"}')


async def _keep_raw_frames(frames: Any) -> Any:
    async for raw in frames:
        if raw["event"] == "raw":
            yield "mapped", raw["data"]


async def _drop_every_frame(frames: Any) -> Any:
    async for _ in frames:
        pass
    return
    yield  # pragma: no cover - unreachable, but makes this an async generator


def test_a_supplied_event_mapper_replaces_the_default_frame_forwarding() -> None:
    stream = FakeStream(frames=[{"event": "raw", "data": {"n": 1}}, {"event": "drop", "data": {}}])
    router = _router(stream_events=_keep_raw_frames)

    with TestClient(_app(router, stream=stream, executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/stream").text

    assert "event: mapped" in body
    assert "event: drop" not in body


def test_the_stream_replays_from_the_database_rather_than_starting_at_the_connection() -> None:
    """Creating and streaming are two requests, so LIVE would drop whatever happened between them.

    This is the whole mitigation for the round trip the two-step contract introduced. A stream that
    reverted to the platform default would still pass every other test here.
    """
    stream = FakeStream()
    router = _router()

    with TestClient(_app(router, stream=stream, executions=_owned())) as client:
        client.get("/demo/executions/exec-1/stream")

    assert stream.event_sources == ["HYBRID"]


def test_the_log_stream_has_its_own_vocabulary() -> None:
    """Log lines are not lifecycle frames; a workflow event mapper would drop every one of them."""
    router = _router(stream_events=_drop_every_frame)

    with TestClient(_app(router, executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/logs/stream").text

    assert "event: execution" in body
    assert 'event: log\ndata: {"body":"line one"}' in body


def test_a_stream_that_breaks_mid_flight_ends_with_an_error_frame() -> None:
    class _Exploding(FakeExecutionCommands):
        async def _log_lines(self) -> Any:
            raise RuntimeError("upstream gone")
            yield  # pragma: no cover - unreachable, but makes this an async generator

    with TestClient(_app(_router(), commands=_Exploding(), executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/logs/stream").text

    assert 'event: error\ndata: {"message":"upstream gone"}' in body


@pytest.mark.parametrize(
    "path", ["/demo/executions/{execution_id}/stream", "/demo/executions/{execution_id}/logs/stream"]
)
def test_a_stream_is_documented_as_an_event_stream_not_as_json(path: str) -> None:
    """Without the explicit `responses`, hey-api types the stream as a JSON body."""
    operation = _app(_router()).openapi()["paths"][path]["get"]

    assert operation["responses"]["200"]["content"] == {"text/event-stream": {}}


# --- the contract -----------------------------------------------------------------------------


def test_no_vendor_schema_reaches_the_generated_document() -> None:
    """Passing the SDK models through would add dozens of schemas, `Unset` sentinel included."""
    schemas = _app(_router()).openapi()["components"]["schemas"]

    assert not [name for name in schemas if "Unrecognized" in name or "Nullable" in name or "Unset" in name]
    assert "WorkflowExecution" in schemas
    assert set(schemas["WorkflowExecution"]["properties"]) == set(WorkflowExecution.model_fields)


def test_the_execution_contract_drops_the_two_fields_the_caller_cannot_use() -> None:
    """`user_id` is the caller by construction and `deployment_name` is infra, not contract."""
    assert "user_id" not in WorkflowExecution.model_fields
    assert "deployment_name" not in WorkflowExecution.model_fields
    assert "run_id" in WorkflowExecution.model_fields


def test_reading_one_execution_maps_the_vendor_model_onto_the_app_one() -> None:
    with TestClient(_app(_router(), executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1").json()

    assert body["execution_id"] == "exec-1"
    assert body["status"] == "COMPLETED"
    assert body["result"] == {"text": "hi"}
    assert "user_id" not in body


def test_an_omitted_vendor_field_becomes_null_rather_than_the_unset_sentinel() -> None:
    """Speakeasy leaves an omitted field holding a model that serialises to a literal string."""
    with TestClient(_app(_router(), executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1").json()

    assert body["run_id"] is None
    assert body["total_duration_ms"] is None
    assert "~?~unset~?~sentinel~?~" not in client.get("/demo/executions/exec-1").text


def test_a_trace_read_keeps_the_envelope_typed_and_the_payload_opaque() -> None:
    with TestClient(_app(_router(), executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/trace/summary").json()

    assert body["execution"]["execution_id"] == "exec-1"
    assert body["data"] is None


def test_the_request_body_is_the_reset_contract_not_the_vendor_one() -> None:
    commands = FakeExecutionCommands()
    app = _app(_router(), commands=commands, executions=_owned())

    with TestClient(app) as client:
        response = client.post(
            "/demo/executions/exec-1/reset", json={"event_id": 7, "reason": "retry", "exclude_signals": True}
        )

    assert response.status_code == 202
    assert response.json() == {"execution_id": "exec-1", "status": "reset_requested"}
    assert commands.calls[0][1] == {
        "execution_id": "exec-1",
        "event_id": 7,
        "reason": "retry",
        "exclude_signals": True,
        "exclude_updates": False,
    }


# --- idempotency ------------------------------------------------------------------------------


def test_a_create_without_an_idempotency_key_never_reserves() -> None:
    """The header is opt-in: with none, the path is the original record-then-start, untouched."""
    start = FakeStart()
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"})

    assert response.status_code == 202
    assert executions.reservations == {}
    assert executions.owned == {(response.json()["execution_id"], OWNER, "demo")}
    assert len(start.calls) == 1


def test_a_repeated_idempotency_key_returns_the_first_execution_without_restarting() -> None:
    """The whole fix: a retried create under the same key never starts a second workflow."""
    start = FakeStart()
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=start, executions=executions)) as client:
        first = client.post("/demo/executions", json={"message": "hello"}, headers={"Idempotency-Key": "k1"})
        second = client.post("/demo/executions", json={"message": "hello"}, headers={"Idempotency-Key": "k1"})

    assert first.status_code == second.status_code == 202
    assert first.json()["execution_id"] == second.json()["execution_id"]
    assert len(start.calls) == 1, "the replay must not start a second workflow"


def test_a_won_reservation_records_ownership_and_starts_once() -> None:
    """A first create under a key records ownership through the reservation and starts normally."""
    start = FakeStart()
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"}, headers={"Idempotency-Key": "k1"})

    execution_id = response.json()["execution_id"]
    assert executions.owned == {(execution_id, OWNER, "demo")}
    assert executions.reservations == {(OWNER, "demo", "k1"): execution_id}
    assert start.calls[0]["execution_id"] == execution_id


def test_another_callers_key_does_not_collide() -> None:
    """Uniqueness is scoped to the triple, so a key already used by someone else is a fresh create."""
    start = FakeStart()
    executions = FakeExecutionStore()
    executions.reservations[("someone-else", "demo", "k1")] = "not-mine"

    with TestClient(_app(_router(), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hello"}, headers={"Idempotency-Key": "k1"})

    assert response.json()["execution_id"] != "not-mine"
    assert len(start.calls) == 1


class _FailingStart(FakeStart):
    """A platform that refuses the start, after the claim for it has already been written."""

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        await super().__call__(*args, **kwargs)
        raise RuntimeError("platform refused the start")


def test_a_failed_create_withdraws_its_claim_so_the_key_stays_usable() -> None:
    """The wedge: without a compensating delete, a key that once failed succeeds forever.

    The reservation is written before the workflow starts. If the start then fails and the row
    survives, every later create under that key matches the reservation and gets back, with a 202,
    an execution that was never started, whose every id-addressed route then 500s.
    """
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=_FailingStart(), executions=executions)) as client:
        with pytest.raises(RuntimeError):
            client.post("/demo/executions", json={"message": "hi"}, headers={"Idempotency-Key": "k1"})

    assert executions.reservations == {}, "a key whose execution never started must stay unclaimed"
    assert executions.owned == set(), "and its ownership row must not outlive it"

    working = FakeStart()
    with TestClient(_app(_router(), start=working, executions=executions)) as client:
        retry = client.post("/demo/executions", json={"message": "hi"}, headers={"Idempotency-Key": "k1"})

    assert retry.status_code == 202
    assert len(working.calls) == 1, "the retry must actually start a workflow, not replay a ghost"


def test_a_refused_create_hook_withdraws_the_claim_too() -> None:
    """A hook refusal is a create that never happened, so it must leave nothing claimed either."""

    class _Refusing:
        async def __call__(self, *, execution_id: str, body: Any, user_id: str) -> bool:
            return False

    executions = FakeExecutionStore()

    with TestClient(_app(_router(on_create=_Refusing()), executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hi"}, headers={"Idempotency-Key": "k1"})

    assert response.status_code == 404
    assert executions.reservations == {}
    assert executions.owned == set()


def test_a_keyless_create_that_fails_leaves_no_orphan_row() -> None:
    executions = FakeExecutionStore()

    with TestClient(_app(_router(), start=_FailingStart(), executions=executions)) as client:
        with pytest.raises(RuntimeError):
            client.post("/demo/executions", json={"message": "hi"})

    assert executions.owned == set()


def test_a_detached_create_publishes_the_idempotency_key_header() -> None:
    parameters = _app(_router()).openapi()["paths"]["/demo/executions"]["post"].get("parameters", [])

    assert any(p["name"] == "Idempotency-Key" and p["in"] == "header" for p in parameters)


def test_a_waited_create_publishes_no_idempotency_key_header() -> None:
    """A waited create returns the workflow result, which a replay cannot reconstruct, so it opts out.

    Both spellings: a route mounted on the un-substituted closure leaks the parameter under its
    bare name as a query string rather than under the alias, which is a leak either way.
    """
    parameters = (
        _app(_router(wait_for_result=True)).openapi()["paths"]["/demo/executions"]["post"].get("parameters", [])
    )

    assert not any(p["name"] in {"Idempotency-Key", "idempotency_key"} for p in parameters)


def test_a_waited_create_ignores_a_supplied_key_and_starts_normally() -> None:
    """The header is not a parameter of the waited route, so FastAPI drops it and nothing reserves."""
    start = FakeStart(result={"echoed": "hi"})
    executions = FakeExecutionStore()

    with TestClient(_app(_router(wait_for_result=True), start=start, executions=executions)) as client:
        response = client.post("/demo/executions", json={"message": "hi"}, headers={"Idempotency-Key": "k1"})

    assert response.status_code == 200
    assert executions.reservations == {}
    assert len(start.calls) == 1


# --- stream resumption ------------------------------------------------------------------------


def test_the_stream_threads_the_last_event_id_header_to_the_platform() -> None:
    """A reconnecting EventSource sends `Last-Event-ID`; without threading it the replay is lost."""
    stream = FakeStream()

    with TestClient(_app(_router(), stream=stream, executions=_owned())) as client:
        client.get("/demo/executions/exec-1/stream", headers={"Last-Event-ID": "evt-7"})

    assert stream.last_event_ids == ["evt-7"]


def test_the_query_cursor_is_a_fallback_when_the_header_is_absent() -> None:
    stream = FakeStream()

    with TestClient(_app(_router(), stream=stream, executions=_owned())) as client:
        client.get("/demo/executions/exec-1/stream", params={"cursor": "evt-3"})

    assert stream.last_event_ids == ["evt-3"]


def test_the_header_wins_over_the_query_cursor() -> None:
    stream = FakeStream()

    with TestClient(_app(_router(), stream=stream, executions=_owned())) as client:
        client.get("/demo/executions/exec-1/stream", params={"cursor": "evt-3"}, headers={"Last-Event-ID": "evt-7"})

    assert stream.last_event_ids == ["evt-7"]


def test_each_streamed_event_carries_its_frames_resume_id() -> None:
    """The browser echoes the last `id:` it saw, so every event must carry its frame's resume id."""
    stream = FakeStream(
        frames=[{"event": "tick", "data": {"n": 1}, "id": "evt-1"}, {"event": "tick", "data": {"n": 2}, "id": "evt-2"}]
    )

    with TestClient(_app(_router(), stream=stream, executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/stream").text

    assert "id: evt-1" in body
    assert "id: evt-2" in body


def test_a_custom_mapper_still_carries_the_frame_resume_id() -> None:
    """The id is tapped outside the mapper, so a custom mapper resumes without changing its contract."""
    stream = FakeStream(frames=[{"event": "raw", "data": {"n": 1}, "id": "evt-9"}])

    with TestClient(_app(_router(stream_events=_keep_raw_frames), stream=stream, executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/stream").text

    assert "event: mapped" in body
    assert "id: evt-9" in body


def test_a_frame_without_a_resume_id_emits_no_id_line_for_its_event() -> None:
    """The default frames carry no id, so only the opening execution frame is addressable — unchanged."""
    stream = FakeStream(frames=[{"event": "completed", "data": {"text": "hi"}}])

    with TestClient(_app(_router(), stream=stream, executions=_owned())) as client:
        body = client.get("/demo/executions/exec-1/stream").text

    assert body.count("\nid: ") == 1, "only the opening execution frame is addressable; the id-less frame adds none"
