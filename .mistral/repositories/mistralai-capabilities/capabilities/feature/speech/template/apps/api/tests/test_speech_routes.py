from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from api.routers.api.v1.speech import realtime as realtime_route
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.speech.schemas import SynthesizeRequest, SynthesizeResult
from mistralai_capabilities.workflows.client import WorkflowRun
from pydantic import BaseModel
from support.auth import FakeUserStore, auth_headers, auth_hooks
from support.workflows_auth import FakeExecutionStore, FakeExecutor, workflow_auth_hooks
from utils.mistral import MistralNotConfiguredError

# isort: split
from conftest import build_app

_SYNTHESIZE_BODY = {"input": "x", "voice_id": "nova"}
_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


@pytest.fixture
def users() -> FakeUserStore:
    return FakeUserStore()


@pytest.fixture
def executor() -> FakeExecutor:
    return FakeExecutor()


@pytest.fixture
def client(executor: FakeExecutor, users: FakeUserStore) -> TestClient:
    hooks = FastAPIHooks.compose(auth_hooks(users), workflow_auth_hooks(executor, FakeExecutionStore()))
    return TestClient(build_app(hooks=hooks, routers="api.routers"))


def _execution_surface(base: str) -> dict[str, set[str]]:
    """The fifteen paths one `WorkflowRouter` mount publishes for a speech workflow."""
    return {
        f"{base}/executions": {"post", "get"},
        f"{base}/executions/cancel": {"post"},
        f"{base}/executions/terminate": {"post"},
        f"{base}/executions/{{execution_id}}": {"get"},
        f"{base}/executions/{{execution_id}}/history": {"get"},
        f"{base}/executions/{{execution_id}}/stream": {"get"},
        f"{base}/executions/{{execution_id}}/cancel": {"post"},
        f"{base}/executions/{{execution_id}}/terminate": {"post"},
        f"{base}/executions/{{execution_id}}/reset": {"post"},
        f"{base}/executions/{{execution_id}}/logs": {"get"},
        f"{base}/executions/{{execution_id}}/logs/stream": {"get"},
        f"{base}/executions/{{execution_id}}/trace/info": {"get"},
        f"{base}/executions/{{execution_id}}/trace/otel": {"get"},
        f"{base}/executions/{{execution_id}}/trace/summary": {"get"},
        f"{base}/executions/{{execution_id}}/trace/events": {"get"},
    }


def test_synthesize_post_starts_the_speech_workflow(client: TestClient, executor: FakeExecutor) -> None:
    executor.results["speech_synthesize"] = SynthesizeResult(
        model="voxtral-test",
        response_format="mp3",
        audio_base64="AAAA",
    )

    res = client.post(
        "/api/v1/speech/synthesize/executions",
        json=_SYNTHESIZE_BODY,
        headers=auth_headers(),
    )

    assert res.status_code == 200
    assert res.json()["audio_base64"] == "AAAA"
    assert executor.calls[-1]["name"] == "speech_synthesize"
    assert executor.calls[-1]["wait_for_result"] is True
    assert isinstance(executor.calls[-1]["input"], SynthesizeRequest)


def test_synthesize_missing_body_is_validation_error(client: TestClient) -> None:
    assert client.post("/api/v1/speech/synthesize/executions", json={}, headers=auth_headers()).status_code == 422


def test_unhandled_speech_workflow_errors_do_not_leak_exception_details() -> None:
    """Starlette's `debug=False` default must not serve upstream exception details."""

    class FailingExecutor(FakeExecutor):
        async def start(
            self,
            workflow_class: type,
            workflow_input: BaseModel,
            *,
            wait_for_result: bool,
            timeout_seconds: float | None = None,
            execution_id: str | None = None,
        ) -> WorkflowRun:
            raise RuntimeError("secret upstream detail")

    error_client = TestClient(
        build_app(
            hooks=FastAPIHooks.compose(
                auth_hooks(FakeUserStore()),
                workflow_auth_hooks(FailingExecutor(), FakeExecutionStore()),
            ),
            routers="api.routers",
        ),
        raise_server_exceptions=False,
    )
    res = error_client.post(
        "/api/v1/speech/synthesize/executions",
        json=_SYNTHESIZE_BODY,
        headers=auth_headers(),
    )

    assert res.status_code == 500
    assert res.text == "Internal Server Error"
    assert "secret upstream detail" not in res.text


def test_speech_contributes_its_route_surfaces(client: TestClient) -> None:
    """Everything the feature serves under ``/speech``, mounts and hand-rolled routes alike.

    The prefix used to be ``/speech/workflows/``, which excluded ``realtime`` by construction, and
    ``voices`` sat at ``/v1`` to stay clear of the old ``/v1/workflows`` tree. With one namespace
    for the feature this pins all four surfaces, so a route can no longer join the feature without
    being named here.
    """
    actual = {
        path: {method for method in item if method in _HTTP_METHODS}
        for path, item in client.app.openapi()["paths"].items()
        if path.startswith("/api/v1/speech/")
    }

    assert actual == {
        **_execution_surface("/api/v1/speech/transcribe"),
        **_execution_surface("/api/v1/speech/synthesize"),
        "/api/v1/speech/realtime/session": {"post"},
        "/api/v1/speech/voices": {"get", "post"},
    }
    assert not [path for path in actual if path.endswith(("/signals", "/queries", "/updates"))], (
        "no speech workflow declares a public signal, query or update handler, so those routes "
        "are derived away - their absence is the feature"
    )


_REALTIME_URL = "/api/v1/speech/realtime/session"


class _FakeSessions:
    """Stands in for ``client.realtime.sessions`` — records the mint request or raises."""

    def __init__(self, *, result: object = None, error: Exception | None = None) -> None:
        self._result = result
        self._error = error
        self.request: dict[str, str] | None = None

    async def create_async(self, *, request: dict[str, str]) -> object:
        self.request = request
        if self._error is not None:
            raise self._error
        return self._result


def _token_result() -> SimpleNamespace:
    return SimpleNamespace(
        client_secret=SimpleNamespace(value="rt_secret", expires_at=datetime(2030, 1, 1, tzinfo=UTC))
    )


def _install_client(monkeypatch: pytest.MonkeyPatch, sessions: _FakeSessions) -> None:
    client = SimpleNamespace(realtime=SimpleNamespace(sessions=sessions))
    monkeypatch.setattr(realtime_route, "caller_mistral_client", lambda: client)


def test_realtime_session_mints_a_token_and_socket_url(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    sessions = _FakeSessions(result=_token_result())
    _install_client(monkeypatch, sessions)

    res = client.post(_REALTIME_URL, json={}, headers=auth_headers())

    assert res.status_code == 200
    body = res.json()
    # Only the token surface crosses to the client — never the server's MISTRAL_API_KEY.
    assert set(body) == {"token", "expires_at", "ws_url"}
    assert body["token"] == "rt_secret"
    assert body["ws_url"].startswith("wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=")
    # The mint asks the SDK for a realtime session with the default model.
    assert sessions.request == {
        "purpose": "realtime",
        "model": "voxtral-mini-transcribe-realtime-2602",
    }


def test_realtime_session_honours_a_requested_model(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    sessions = _FakeSessions(result=_token_result())
    _install_client(monkeypatch, sessions)

    res = client.post(_REALTIME_URL, json={"model": "voxtral-custom"}, headers=auth_headers())

    assert res.status_code == 200
    assert sessions.request == {"purpose": "realtime", "model": "voxtral-custom"}
    assert res.json()["ws_url"].endswith("model=voxtral-custom")


def test_realtime_session_upstream_failure_does_not_leak_detail(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_client(monkeypatch, _FakeSessions(error=RuntimeError("secret upstream detail")))

    res = client.post(_REALTIME_URL, json={}, headers=auth_headers())

    assert res.status_code == 503
    assert "secret upstream detail" not in res.text
    assert res.json()["detail"] == "Session creation failed: RuntimeError"


def test_realtime_session_without_a_configured_key_is_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _raise() -> object:
        raise MistralNotConfiguredError("MISTRAL_API_KEY is not configured")

    monkeypatch.setattr(realtime_route, "caller_mistral_client", _raise)

    res = client.post(_REALTIME_URL, json={}, headers=auth_headers())

    assert res.status_code == 503
    assert res.json()["detail"] == "MISTRAL_API_KEY is not configured"
