"""The one chat route that forwards nowhere.

A rating has no home on the control plane; its API declares no score and no verb that mutates a
session after it starts. So this route emits a Studio observability event and writes nothing. Two
things are pinned: the event is the shape Mistral documents (asserted against a real exporter, not a
stub), and a vote never reaches the control plane.
"""

from typing import Any

import pytest
from api.routers.api.v1.chat import feedback as feedback_route
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.fastapi_auth.identity import HEADER_USER_ID
from opentelemetry._logs import get_logger_provider, set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    InMemoryLogRecordExporter,
    SimpleLogRecordProcessor,
)
from support.auth import FakeUserStore, auth_headers, auth_hooks
from support.workflows_auth import FakeExecutionStore, FakeExecutor, workflow_auth_hooks
from utils.telemetry import EVALUATION_EVENT_NAME, record_evaluation_result

from conftest import build_app

SESSION_ID = "44444444-4444-4444-4444-444444444444"


@pytest.fixture
def users() -> FakeUserStore:
    return FakeUserStore()


@pytest.fixture
def executor() -> FakeExecutor:
    return FakeExecutor()


@pytest.fixture
def executions() -> FakeExecutionStore:
    return FakeExecutionStore()


@pytest.fixture
def client(executor: FakeExecutor, users: FakeUserStore, executions: FakeExecutionStore) -> TestClient:
    return TestClient(
        build_app(
            hooks=FastAPIHooks.compose(auth_hooks(users), workflow_auth_hooks(executor, executions)),
            routers="api.routers",
        )
    )


@pytest.fixture
def emitted(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """What the route asked telemetry to record.

    Patched on the route module rather than on `utils.telemetry`, because the route binds the
    name at import and would keep calling the original through a patch applied to the source.
    """
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        feedback_route,
        "record_evaluation_result",
        lambda **kwargs: calls.append(kwargs),
    )
    return calls


def _rate(client: TestClient, rating: str, **overrides: Any) -> Any:
    body = {
        "session_id": SESSION_ID,
        "message_id": "message-3",
        "rating": rating,
        **overrides,
    }
    return client.post("/api/v1/chat/feedback", headers=auth_headers(), json=body)


@pytest.mark.parametrize(
    ("rating", "score_value", "score_label"),
    [("up", 1.0, "positive"), ("down", 0.0, "negative")],
)
def test_a_vote_is_recorded_as_a_scored_evaluation(
    client: TestClient,
    emitted: list[dict[str, Any]],
    rating: str,
    score_value: float,
    score_label: str,
) -> None:
    response = _rate(client, rating)

    assert response.status_code == 204
    assert len(emitted) == 1
    assert emitted[0]["name"] == "user_feedback"
    assert emitted[0]["score_value"] == score_value
    assert emitted[0]["score_label"] == score_label


def test_the_vote_carries_the_session_so_studio_can_group_it_by_conversation(
    client: TestClient, emitted: list[dict[str, Any]]
) -> None:
    """`gen_ai.conversation.id` is how the Trace Explorer filters, and it is the only correlation
    this app has: the control plane issues no id for an assistant answer."""
    _rate(client, "up")

    attributes = emitted[0]["attributes"]
    assert attributes["gen_ai.conversation.id"] == SESSION_ID
    assert attributes["mistral.message.id"] == "message-3"
    assert attributes["enduser.id"] == auth_headers()[HEADER_USER_ID]


TRACE_ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
SPAN_ID = "1122334455667788"


def test_a_caller_that_knows_the_span_pins_the_rating_to_it(client: TestClient, emitted: list[dict[str, Any]]) -> None:
    _rate(client, "up", trace_id=TRACE_ID, span_id=SPAN_ID)

    assert emitted[0]["trace_id"] == TRACE_ID
    assert emitted[0]["span_id"] == SPAN_ID


def test_a_rating_with_no_span_floats_free_rather_than_inventing_one(
    client: TestClient, emitted: list[dict[str, Any]]
) -> None:
    """A fabricated id would address a trace that does not exist, which reads worse than none."""
    _rate(client, "up")

    assert emitted[0]["trace_id"] is None
    assert emitted[0]["span_id"] is None


@pytest.mark.parametrize(
    ("field", "value"),
    [("trace_id", "nothex"), ("span_id", "tooshort"), ("trace_id", "ABC")],
)
def test_a_malformed_span_reference_is_refused(
    client: TestClient, emitted: list[dict[str, Any]], field: str, value: str
) -> None:
    """`int(..., 16)` would raise inside the emitter and turn a rating into a 500."""
    assert _rate(client, "up", **{field: value}).status_code == 422
    assert emitted == []


def test_the_span_context_reaches_the_emitted_record() -> None:
    """End of the chain, against a real exporter: Studio reads these off the record itself."""
    exporter = InMemoryLogRecordExporter()
    provider = get_logger_provider()
    if not isinstance(provider, LoggerProvider):
        provider = LoggerProvider()
        set_logger_provider(provider)
    provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))

    record_evaluation_result(
        name="user_feedback",
        score_value=1.0,
        score_label="positive",
        trace_id=TRACE_ID,
        span_id=SPAN_ID,
    )
    provider.force_flush()

    record = exporter.get_finished_logs()[-1].log_record
    assert f"{record.trace_id:032x}" == TRACE_ID
    assert f"{record.span_id:016x}" == SPAN_ID


def test_a_rating_outside_the_two_choices_is_refused(client: TestClient, emitted: list[dict[str, Any]]) -> None:
    assert _rate(client, "sideways").status_code == 422
    assert emitted == []


def test_rating_requires_a_caller(client: TestClient) -> None:
    response = client.post(
        "/api/v1/chat/feedback",
        json={"session_id": SESSION_ID, "message_id": "message-3", "rating": "up"},
    )

    assert response.status_code == 401


def test_a_vote_is_never_sent_to_the_control_plane(client: TestClient, emitted: list[dict[str, Any]]) -> None:
    """The control plane has no rating surface, so reaching for it would be a 404 per click."""
    from mistralai_capabilities.chat.vibe.sessions import _sessions

    calls: list[str] = []

    class Unreachable:
        def __getattr__(self, name: str) -> Any:
            calls.append(name)
            raise AssertionError(f"the feedback route must not call the control plane ({name})")

    client.app.dependency_overrides[_sessions] = Unreachable
    try:
        assert _rate(client, "up").status_code == 204
    finally:
        client.app.dependency_overrides.pop(_sessions, None)
    assert calls == []


def test_the_emitted_event_is_the_shape_mistral_documents() -> None:
    """Against a real exporter: a stub would pass whatever spelling this app invented."""
    exporter = InMemoryLogRecordExporter()
    # Attached to whatever provider is installed rather than replacing it: OTel refuses a second
    # `set_logger_provider` with a warning and keeps the first, which would silently collect
    # nothing here.
    provider = get_logger_provider()
    if not isinstance(provider, LoggerProvider):
        provider = LoggerProvider()
        set_logger_provider(provider)
    provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))

    record_evaluation_result(
        name="user_feedback",
        score_value=0.0,
        score_label="negative",
        attributes={"gen_ai.conversation.id": SESSION_ID},
    )
    provider.force_flush()

    (emitted_log,) = exporter.get_finished_logs()
    record = emitted_log.log_record
    assert record.event_name == EVALUATION_EVENT_NAME == "gen_ai.evaluation.result"
    assert record.attributes["gen_ai.evaluation.name"] == "user_feedback"
    assert record.attributes["gen_ai.evaluation.score.value"] == 0.0
    assert record.attributes["gen_ai.evaluation.score.label"] == "negative"
    assert record.attributes["gen_ai.conversation.id"] == SESSION_ID
