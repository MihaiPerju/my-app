from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, Self

import mistralai.workflows as workflows
import pytest
from env.workflows import env as workflows_env
from pydantic import BaseModel
from mistralai_capabilities.workflows import client as workflows_client

_BASE_URL = workflows_env.workflows_base_url


class _Recorder:
    """Answers any method name, recording the call and returning a canned result.

    Every wrapper under test is a keyword-only passthrough, so the assertion worth making is
    which SDK method received which kwargs. A permissive fake keeps that the only observable
    thing; a hand-written stub per method would let a typo pass as a new attribute.
    """

    def __init__(self, result: Any = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.result = result

    def __getattr__(self, name: str) -> Callable[..., Awaitable[Any]]:
        async def call(**kwargs: Any) -> Any:
            self.calls.append((name, kwargs))
            return self.result

        return call

    @property
    def method(self) -> str:
        return self.calls[0][0]

    @property
    def kwargs(self) -> dict[str, Any]:
        return self.calls[0][1]


class _FakeStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.closed = False

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: Any) -> None:
        self.closed = True

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> Any:
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


def _install(monkeypatch: pytest.MonkeyPatch, *, executions: Any = None, runs: Any = None) -> None:
    client = SimpleNamespace(workflows=SimpleNamespace(executions=executions, runs=runs))
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: client)


class StartInput(BaseModel):
    message: str


@workflows.workflow.define(name="clients_test_start")
class StartableWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: StartInput) -> StartInput:
        return request


class _StartRecorder:
    def __init__(self, answers: str) -> None:
        self.answers = answers
        self.kwargs: dict[str, Any] = {}

    async def execute_workflow_async(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        return SimpleNamespace(execution_id=self.answers, result=None)


def _install_start(monkeypatch: pytest.MonkeyPatch, recorder: _StartRecorder) -> None:
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: SimpleNamespace(workflows=recorder))


async def test_start_omits_the_execution_id_unless_the_caller_mints_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """The SDK's UNSET default must survive: an explicit null is a different request."""
    recorder = _StartRecorder(answers="platform-1")
    _install_start(monkeypatch, recorder)

    run = await workflows_client.start_workflow(StartableWorkflow, StartInput(message="hi"), wait_for_result=False)

    assert "execution_id" not in recorder.kwargs
    assert run.execution_id == "platform-1"


async def test_start_forwards_a_caller_minted_execution_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Naming the execution up front is what lets a caller authorise it before it exists."""
    recorder = _StartRecorder(answers="mine-1")
    _install_start(monkeypatch, recorder)

    run = await workflows_client.start_workflow(
        StartableWorkflow, StartInput(message="hi"), wait_for_result=False, execution_id="mine-1"
    )

    assert recorder.kwargs["execution_id"] == "mine-1"
    assert run.execution_id == "mine-1"


async def test_start_refuses_a_response_naming_a_different_execution(monkeypatch: pytest.MonkeyPatch) -> None:
    """Returning the other id would hand back an execution the caller's ownership row misses."""
    recorder = _StartRecorder(answers="someone-else")
    _install_start(monkeypatch, recorder)

    with pytest.raises(workflows_client.ExecutionIdMismatchError):
        await workflows_client.start_workflow(
            StartableWorkflow, StartInput(message="hi"), wait_for_result=False, execution_id="mine-1"
        )


_EXECUTION_ID_ONLY = [
    (workflows_client.get_execution, "get_workflow_execution_async"),
    (workflows_client.terminate_execution, "terminate_workflow_execution_async"),
    (workflows_client.get_execution_trace_info, "get_workflow_execution_trace_info_async"),
    (workflows_client.get_execution_trace_otel, "get_workflow_execution_trace_otel_async"),
    (workflows_client.get_execution_trace_summary, "get_workflow_execution_trace_summary_async"),
]


@pytest.mark.parametrize(("wrapper", "sdk_method"), _EXECUTION_ID_ONLY, ids=[name for _, name in _EXECUTION_ID_ONLY])
async def test_execution_id_only_wrappers_target_the_right_method(
    monkeypatch: pytest.MonkeyPatch,
    wrapper: Callable[..., Awaitable[Any]],
    sdk_method: str,
) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await wrapper("exec-1")

    assert executions.method == sdk_method
    assert executions.kwargs == {"execution_id": "exec-1", "server_url": _BASE_URL}


async def test_every_wrapper_forwards_the_workflows_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    # A missing server_url silently targets the SDK's default host, which is a live-traffic
    # failure no other assertion in this suite would catch.
    executions = _Recorder()
    runs = _Recorder(result=None)
    _install(monkeypatch, executions=executions, runs=runs)

    await workflows_client.get_execution("e")
    await workflows_client.get_execution_history("e")
    await workflows_client.terminate_execution("e")
    await workflows_client.cancel_execution("e")
    await workflows_client.batch_cancel_executions(["e"])
    await workflows_client.batch_terminate_executions(["e"])
    await workflows_client.signal_execution("e", name="s")
    await workflows_client.query_execution("e", name="q")
    await workflows_client.update_execution("e", name="u")
    await workflows_client.reset_execution("e", event_id=1)
    await workflows_client.get_execution_logs("e")
    await workflows_client.get_execution_trace_info("e")
    await workflows_client.get_execution_trace_otel("e")
    await workflows_client.get_execution_trace_summary("e")
    await workflows_client.get_execution_trace_events("e")
    await workflows_client.list_runs()

    assert len(executions.calls) == 15
    assert all(kwargs["server_url"] == _BASE_URL for _, kwargs in executions.calls)
    assert runs.kwargs["server_url"] == _BASE_URL


async def test_history_omits_decode_payloads_unless_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder(result={"events": []})
    _install(monkeypatch, executions=executions)

    assert await workflows_client.get_execution_history("exec-1") == {"events": []}
    assert executions.method == "get_workflow_execution_history_async"
    assert "decode_payloads" not in executions.kwargs

    await workflows_client.get_execution_history("exec-1", decode_payloads=False)
    assert executions.calls[1][1]["decode_payloads"] is False


@pytest.mark.parametrize(
    ("wrapper", "sdk_method"),
    [
        (workflows_client.batch_cancel_executions, "batch_cancel_workflow_executions_async"),
        (workflows_client.batch_terminate_executions, "batch_terminate_workflow_executions_async"),
    ],
    ids=["cancel", "terminate"],
)
async def test_batch_wrappers_pass_the_id_list(
    monkeypatch: pytest.MonkeyPatch,
    wrapper: Callable[..., Awaitable[Any]],
    sdk_method: str,
) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await wrapper(["a", "b"])

    assert executions.method == sdk_method
    assert executions.kwargs == {"execution_ids": ["a", "b"], "server_url": _BASE_URL}


@pytest.mark.parametrize(
    ("wrapper", "sdk_method"),
    [
        (workflows_client.signal_execution, "signal_workflow_execution_async"),
        (workflows_client.query_execution, "query_workflow_execution_async"),
        (workflows_client.update_execution, "update_workflow_execution_async"),
    ],
    ids=["signal", "query", "update"],
)
async def test_invocation_wrappers_pass_name_and_input(
    monkeypatch: pytest.MonkeyPatch,
    wrapper: Callable[..., Awaitable[Any]],
    sdk_method: str,
) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await wrapper("exec-1", name="approve", input={"ok": True})

    assert executions.method == sdk_method
    assert executions.kwargs == {
        "execution_id": "exec-1",
        "name": "approve",
        "input": {"ok": True},
        "server_url": _BASE_URL,
    }


async def test_invocation_wrappers_omit_an_absent_input(monkeypatch: pytest.MonkeyPatch) -> None:
    # The SDK's own UNSET default must survive: sending an explicit null is a different request.
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await workflows_client.signal_execution("exec-1", name="approve")

    assert "input" not in executions.kwargs


async def test_reset_omits_an_absent_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await workflows_client.reset_execution("exec-1", event_id=7)

    assert "reason" not in executions.kwargs


async def test_reset_passes_the_event_id_and_exclusion_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await workflows_client.reset_execution("exec-1", event_id=7, reason="bad input", exclude_updates=True)

    assert executions.method == "reset_workflow_async"
    assert executions.kwargs == {
        "execution_id": "exec-1",
        "event_id": 7,
        "reason": "bad input",
        "exclude_signals": False,
        "exclude_updates": True,
        "server_url": _BASE_URL,
    }


async def test_logs_pass_every_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)
    after = datetime(2026, 1, 1, tzinfo=UTC)
    before = datetime(2026, 1, 2, tzinfo=UTC)

    await workflows_client.get_execution_logs(
        "exec-1",
        run_id="run-1",
        activity_id="act-1",
        after=after,
        before=before,
        order="desc",
        cursor="c",
        limit=10,
    )

    assert executions.method == "get_workflow_execution_logs_async"
    assert executions.kwargs == {
        "execution_id": "exec-1",
        "run_id": "run-1",
        "activity_id": "act-1",
        "after": after,
        "before": before,
        "order": "desc",
        "cursor": "c",
        "limit": 10,
        "server_url": _BASE_URL,
    }


async def test_logs_send_only_the_execution_id_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await workflows_client.get_execution_logs("exec-1")

    assert executions.kwargs == {"execution_id": "exec-1", "server_url": _BASE_URL}


async def test_trace_events_pass_both_toggles(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder()
    _install(monkeypatch, executions=executions)

    await workflows_client.get_execution_trace_events("exec-1", merge_same_id_events=True)

    assert executions.method == "get_workflow_execution_trace_events_async"
    assert executions.kwargs == {
        "execution_id": "exec-1",
        "merge_same_id_events": True,
        "include_internal_events": False,
        "server_url": _BASE_URL,
    }


async def test_stream_execution_forwards_event_source(monkeypatch: pytest.MonkeyPatch) -> None:
    stream = _FakeStream(["a", "b"])
    executions = _Recorder(result=stream)
    _install(monkeypatch, executions=executions)

    events = [event async for event in workflows_client.stream_execution("exec-1", event_source="HYBRID")]

    assert events == ["a", "b"]
    assert stream.closed is True
    assert executions.method == "stream_async"
    assert executions.kwargs == {
        "execution_id": "exec-1",
        "event_source": "HYBRID",
        "server_url": _BASE_URL,
    }


async def test_stream_execution_stays_silent_about_an_unset_event_source(monkeypatch: pytest.MonkeyPatch) -> None:
    executions = _Recorder(result=_FakeStream([]))
    _install(monkeypatch, executions=executions)

    assert [event async for event in workflows_client.stream_execution("exec-1", last_event_id="7")] == []
    assert executions.kwargs == {"execution_id": "exec-1", "last_event_id": "7", "server_url": _BASE_URL}


async def test_stream_execution_logs_yields_and_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    stream = _FakeStream(["line"])
    executions = _Recorder(result=stream)
    _install(monkeypatch, executions=executions)

    events = [event async for event in workflows_client.stream_execution_logs("exec-1", run_id="run-1")]

    assert events == ["line"]
    assert stream.closed is True
    assert executions.method == "stream_workflow_execution_logs_async"
    assert executions.kwargs == {"execution_id": "exec-1", "run_id": "run-1", "server_url": _BASE_URL}


async def test_list_runs_passes_every_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    page = object()
    runs = _Recorder(result=SimpleNamespace(result=page, next=lambda: None))
    _install(monkeypatch, runs=runs)
    after = datetime(2026, 1, 1, tzinfo=UTC)
    before = datetime(2026, 1, 2, tzinfo=UTC)

    returned = await workflows_client.list_runs(
        workflow_identifier="agents",
        root_execution_id="root-1",
        search="term",
        status="RUNNING",
        deployment_name="prod",
        sort_by="start_time",
        order="asc",
        start_time_after=after,
        start_time_before=before,
        end_time_after=after,
        end_time_before=before,
        user_id="u-1",
        workflow_tags=["t"],
        include_internal=False,
        page_size=10,
        next_page_token="tok",
    )

    assert returned is page
    assert runs.method == "list_runs_async"
    assert runs.kwargs == {
        "workflow_identifier": "agents",
        "root_execution_id": "root-1",
        "search": "term",
        "status": "RUNNING",
        "deployment_name": "prod",
        "sort_by": "start_time",
        "order": "asc",
        "start_time_after": after,
        "start_time_before": before,
        "end_time_after": after,
        "end_time_before": before,
        "user_id": "u-1",
        "workflow_tags": ["t"],
        "include_internal": False,
        "page_size": 10,
        "next_page_token": "tok",
        "server_url": _BASE_URL,
    }


async def test_list_runs_sends_no_filters_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    runs = _Recorder(result=None)
    _install(monkeypatch, runs=runs)

    assert await workflows_client.list_runs() is None
    assert runs.kwargs == {"server_url": _BASE_URL}
