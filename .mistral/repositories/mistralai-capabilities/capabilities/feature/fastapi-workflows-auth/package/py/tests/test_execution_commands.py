"""The dependencies in `mistralai_capabilities.fastapi_workflows_auth.commands` are only useful if they resolve
and if they can be replaced.
"""

from collections.abc import AsyncIterator
from typing import Any, cast

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi_workflows_auth import commands as execution_commands
from mistralai_capabilities.workflows import client as workflows_client
from mistralai_capabilities.workflows.client import MistralError

EXECUTION_COMMANDS = [
    "get_execution",
    "get_execution_history",
    "terminate_execution",
    "batch_cancel_executions",
    "batch_terminate_executions",
    "signal_execution",
    "query_execution",
    "update_execution",
    "reset_execution",
    "get_execution_logs",
    "stream_execution_logs",
    "get_execution_trace_info",
    "get_execution_trace_otel",
    "get_execution_trace_summary",
    "get_execution_trace_events",
]

EXECUTION_COMMAND_ADAPTERS = [
    execution_commands.ClientExecutionCommands,
    execution_commands.RetryingExecutionCommands,
]


@pytest.mark.parametrize("operation", EXECUTION_COMMANDS)
def test_every_command_is_the_client_function_of_the_same_name(operation: str) -> None:
    """The facade adds no behaviour, so a name that drifts from `mistralai_capabilities.workflows.client` is a bug."""
    assert getattr(execution_commands._commands(), operation) is getattr(workflows_client, operation)


def test_the_protocol_declares_exactly_the_operations_the_routes_call() -> None:
    """A method on one side and not the other means a route can ask for something unimplemented."""
    declared = {name for name in vars(execution_commands.ExecutionCommands) if not name.startswith("_")}

    assert declared == set(EXECUTION_COMMANDS)


@pytest.mark.parametrize("adapter", EXECUTION_COMMAND_ADAPTERS, ids=lambda adapter: adapter.__name__)
def test_every_adapter_binds_exactly_the_operations_the_protocol_declares(adapter: type) -> None:
    """Both adapters restate the Protocol by hand, and the type system does not check either.
    An operation added to the Protocol but missed here is an `AttributeError` on a live route,
    so this asserts parity per adapter.
    """
    assert {name for name in vars(adapter) if not name.startswith("_")} == set(EXECUTION_COMMANDS)


def test_the_lifecycle_dependencies_still_resolve_to_their_client_functions() -> None:
    """`Start`/`Stream`/`Cancel` are consumed by the speech and agents routers; the facade is additive."""
    assert execution_commands._start() is workflows_client.start_workflow
    assert execution_commands._stream() is workflows_client.stream_execution
    assert execution_commands._cancel() is workflows_client.cancel_execution


def test_the_facade_is_one_instance_rather_than_one_per_resolution() -> None:
    """Stated in the code as a property of a stateless adapter; pin it so a refactor keeps it true."""
    assert execution_commands._commands() is execution_commands._commands()


class _FakeCommands:
    def __init__(self) -> None:
        self.seen: list[str] = []

    async def get_execution(self, execution_id: str) -> Any:
        self.seen.append(execution_id)
        return {"execution_id": execution_id, "status": "COMPLETED"}

    def stream_execution_logs(self, execution_id: str, **_: Any) -> AsyncIterator[Any]:
        self.seen.append(execution_id)
        return _one_log_line()


async def _one_log_line() -> AsyncIterator[Any]:
    yield {"message": "hello"}


def _probe_app() -> FastAPI:
    app = FastAPI()

    @app.get("/probe/{execution_id}")
    async def probe(execution_id: str, commands: execution_commands.Commands) -> Any:
        return await commands.get_execution(execution_id)

    return app


def test_a_route_declaring_commands_can_have_it_replaced_by_one_override() -> None:
    """The point of the facade: faking sixteen operations costs a single `dependency_overrides` entry."""
    app = _probe_app()
    fake = _FakeCommands()
    app.dependency_overrides[execution_commands._commands] = lambda: fake

    with TestClient(app) as client:
        response = client.get("/probe/exec-123")

    assert response.status_code == 200
    assert response.json() == {"execution_id": "exec-123", "status": "COMPLETED"}
    assert fake.seen == ["exec-123"]


def test_without_an_override_the_route_gets_the_real_client_adapter() -> None:
    """An override that only *looks* installed would silently reach the platform in a test."""
    resolved: list[Any] = []
    app = FastAPI()

    @app.get("/probe")
    async def probe(commands: execution_commands.Commands) -> str:
        resolved.append(commands)
        return "ok"

    with TestClient(app) as client:
        assert client.get("/probe").status_code == 200

    assert resolved == [execution_commands._commands()]
    assert isinstance(resolved[0], execution_commands.ClientExecutionCommands)


async def test_a_fake_can_satisfy_the_streaming_command_without_a_coroutine() -> None:
    """`stream_execution_logs` is an async generator function, so it is called, not awaited."""
    fake = _FakeCommands()

    assert [event async for event in fake.stream_execution_logs("exec-9")] == [{"message": "hello"}]


# --- retry on transient reads -----------------------------------------------------------------


def _transient(status_code: int) -> MistralError:
    return MistralError("boom", httpx.Response(status_code))


class _Flaky:
    """Fails a read (and a write) with a set status a set number of times, then succeeds."""

    def __init__(self, *, fail_times: int, status_code: int = 503) -> None:
        self.fail_times = fail_times
        self.status_code = status_code
        self.reads = 0
        self.writes = 0

    async def get_execution(self, execution_id: str) -> Any:
        self.reads += 1
        if self.reads <= self.fail_times:
            raise _transient(self.status_code)
        return {"execution_id": execution_id}

    async def terminate_execution(self, execution_id: str) -> None:
        self.writes += 1
        if self.writes <= self.fail_times:
            raise _transient(self.status_code)


def _retrying(inner: _Flaky) -> execution_commands.RetryingExecutionCommands:
    return execution_commands.RetryingExecutionCommands(cast(execution_commands.ExecutionCommands, inner))


@pytest.fixture(autouse=True)
def _no_backoff_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """The retry sleeps are real time; zero them so the retry tests do not pay for the back-off."""
    monkeypatch.setattr(execution_commands, "_RETRY_BASE_SECONDS", 0)
    monkeypatch.setattr(execution_commands, "_RETRY_MAX_JITTER_SECONDS", 0)


def test_mistral_error_is_reexported_from_the_sdk_boundary() -> None:
    """`core/api` must not import `mistralai`, so the retryable error rides the workflow-client interface."""
    assert "MistralError" in workflows_client.__all__
    assert workflows_client.MistralError is MistralError


async def test_a_read_retries_a_transient_status_then_succeeds() -> None:
    inner = _Flaky(fail_times=2, status_code=503)

    assert await _retrying(inner).get_execution("e") == {"execution_id": "e"}
    assert inner.reads == 3


async def test_a_read_does_not_retry_a_conflict() -> None:
    """409 is idempotency's answer, not a transient fault; retrying it hammers a settled refusal."""
    inner = _Flaky(fail_times=1, status_code=409)

    with pytest.raises(MistralError):
        await _retrying(inner).get_execution("e")
    assert inner.reads == 1


async def test_a_read_gives_up_after_the_attempt_budget() -> None:
    inner = _Flaky(fail_times=99, status_code=503)

    with pytest.raises(MistralError):
        await _retrying(inner).get_execution("e")
    assert inner.reads == execution_commands._RETRY_ATTEMPTS


async def test_a_write_is_never_retried_even_on_a_transient_status() -> None:
    """A retried write could act twice, so a terminate that 503s fails on the first raise."""
    inner = _Flaky(fail_times=1, status_code=503)

    with pytest.raises(MistralError):
        await _retrying(inner).terminate_execution("e")
    assert inner.writes == 1


def test_the_default_commands_stay_the_plain_facade() -> None:
    """The retry adapter is host-installed; the default provider must still be the identity facade."""
    assert isinstance(execution_commands._commands(), execution_commands.ClientExecutionCommands)
