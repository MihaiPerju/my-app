import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mistralai_capabilities.document_annotation_ui.schemas import DocumentReviewState, WorkflowRunStatus
from mistralai_capabilities.document_annotation_ui.workflows_catalog import (
    DOCUMENT_ANNOTATION_UI_WORKFLOWS,
)
from pydantic import BaseModel, ConfigDict

from .support import USER_ID, FakeExecutionStore, auth, build_app

_EXECUTION_ID = "exec-review"
_BASE_REVIEW = f"/api/v1/document_annotation_ui/review/executions/{_EXECUTION_ID}"
_DOCUMENT = f"/api/v1/document_annotation_ui/reviews/{_EXECUTION_ID}/document"
_IMAGES = f"/api/v1/document_annotation_ui/reviews/{_EXECUTION_ID}/images/img-0"


class QueryResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    result: object


class UpdateResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    update_name: str = "review_result"
    result: object = None


class FakeCommands:
    def __init__(self, state: DocumentReviewState, *, outcome: dict[str, object] | None = None) -> None:
        self.state = state
        self.queries: list[dict[str, object]] = []
        self.updates: list[dict[str, object]] = []
        self._outcome = outcome

    async def query_execution(self, execution_id: str, *, name: str, input: object | None = None) -> QueryResponse:
        self.queries.append({"execution_id": execution_id, "name": name, "input": input})
        return QueryResponse(result=self.state.model_dump(mode="json"))

    async def update_execution(self, execution_id: str, *, name: str, input: object | None = None) -> UpdateResponse:
        self.updates.append({"execution_id": execution_id, "name": name, "input": input})
        if self._outcome is not None:
            return UpdateResponse(result=self._outcome)
        decision = input["decision"] if isinstance(input, dict) else None
        return UpdateResponse(result={"accepted": True, "decision": decision})


def _state(status: WorkflowRunStatus, current_review_step: str | None) -> DocumentReviewState:
    return DocumentReviewState(
        status=status,
        current_review_step=current_review_step,
        document_key=f"users/{USER_ID}/documents/review.pdf",
        file_name="review.pdf",
        mime_type="application/pdf",
    )


def _owned_executions() -> FakeExecutionStore:
    return FakeExecutionStore({(_EXECUTION_ID, USER_ID, DOCUMENT_ANNOTATION_UI_WORKFLOWS[0].name)})


def _app(commands: FakeCommands, executions: FakeExecutionStore | None = None) -> FastAPI:
    return build_app(commands=commands, executions=executions)


@pytest.mark.parametrize(
    "state",
    [
        _state(WorkflowRunStatus.COMPLETED, "extraction_review"),
        _state(WorkflowRunStatus.PENDING_REVIEW, None),
    ],
)
def test_submit_review_refuses_when_the_run_is_not_awaiting_a_step(state: DocumentReviewState) -> None:
    commands = FakeCommands(state)

    response = TestClient(_app(commands, _owned_executions())).post(
        f"{_BASE_REVIEW}/review",
        headers=auth(),
        json={"decision": "approved"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "This run is not awaiting review"}
    assert commands.updates == []


def test_submit_review_refuses_a_body_step_that_is_not_the_awaited_step() -> None:
    commands = FakeCommands(_state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"))

    response = TestClient(_app(commands, _owned_executions())).post(
        f"{_BASE_REVIEW}/review",
        headers=auth(),
        json={"decision": "approved", "step": "classification_review"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "This run is not awaiting review"}
    assert commands.updates == []


def test_submit_review_updates_the_run_and_persists_the_confirmed_decision() -> None:
    commands = FakeCommands(_state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"))
    executions = _owned_executions()

    response = TestClient(_app(commands, executions)).post(
        f"{_BASE_REVIEW}/review",
        headers=auth(),
        json={"decision": "approved"},
    )

    assert response.status_code == 202
    assert commands.updates == [
        {
            "execution_id": _EXECUTION_ID,
            "name": "review_result",
            "input": {
                "step": "extraction_review",
                "decision": "approved",
                "reviewed_output": None,
                "note": None,
                "reviewed_by": USER_ID,
            },
        }
    ]
    # The persisted badge is exactly what the update confirmed the run accepted.
    assert executions.outcomes_by_owner == {(_EXECUTION_ID, USER_ID): "approved"}


def test_submit_review_persists_the_run_confirmed_decision_not_the_callers() -> None:
    # The update returns the decision the run actually accepted — a concurrent submit won first with a
    # different one. The badge must reflect the run outcome, never this caller's losing submission.
    commands = FakeCommands(
        _state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"),
        outcome={"accepted": True, "decision": "rejected"},
    )
    executions = _owned_executions()

    response = TestClient(_app(commands, executions)).post(
        f"{_BASE_REVIEW}/review", headers=auth(), json={"decision": "approved"}
    )

    assert response.status_code == 202
    assert executions.outcomes_by_owner == {(_EXECUTION_ID, USER_ID): "rejected"}


def test_submit_review_409_when_the_update_reports_the_gate_closed() -> None:
    # The run left the gate between the pre-check and the update; the update reports it did not accept
    # the submission, so nothing is persisted.
    commands = FakeCommands(
        _state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"),
        outcome={"accepted": False},
    )
    executions = _owned_executions()

    response = TestClient(_app(commands, executions)).post(
        f"{_BASE_REVIEW}/review", headers=auth(), json={"decision": "approved"}
    )

    assert response.status_code == 409
    assert executions.outcomes_by_owner == {}


def test_submit_review_422_when_the_update_reports_an_invalid_edit() -> None:
    # The workflow validated the approved edit against the schema and rejected it; the API surfaces
    # that as a 422 carrying the field errors, and persists nothing.
    commands = FakeCommands(
        _state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"),
        outcome={
            "accepted": False,
            "reason": "invalid",
            "validation_errors": [{"path": "amount", "message": "Input should be a valid number"}],
        },
    )
    executions = _owned_executions()

    response = TestClient(_app(commands, executions)).post(
        f"{_BASE_REVIEW}/review", headers=auth(), json={"decision": "approved"}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == [{"path": "amount", "message": "Input should be a valid number"}]
    assert executions.outcomes_by_owner == {}


class _FailingUpdateCommands(FakeCommands):
    async def update_execution(self, execution_id: str, *, name: str, input: object | None = None) -> UpdateResponse:
        raise RuntimeError("temporal is unavailable")


def test_submit_review_persists_nothing_when_the_update_fails() -> None:
    # A failed update means the run never accepted the decision, so nothing is persisted and the
    # submit is safely retryable — no decided-but-paused wedge.
    commands = _FailingUpdateCommands(_state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"))
    executions = _owned_executions()

    with pytest.raises(RuntimeError, match="temporal is unavailable"):
        TestClient(_app(commands, executions)).post(
            f"{_BASE_REVIEW}/review", headers=auth(), json={"decision": "approved"}
        )

    assert executions.outcomes_by_owner == {}


def test_submit_review_refuses_a_second_submission_once_a_decision_is_persisted() -> None:
    commands = FakeCommands(_state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"))
    executions = _owned_executions()
    executions.outcomes_by_owner[(_EXECUTION_ID, USER_ID)] = "approved"

    response = TestClient(_app(commands, executions)).post(
        f"{_BASE_REVIEW}/review",
        headers=auth(),
        json={"decision": "approved"},
    )

    assert response.status_code == 409
    assert commands.updates == []


@pytest.mark.parametrize(
    ("method", "path", "body", "owned_status"),
    [
        ("get", f"{_BASE_REVIEW}/review-state", None, 200),
        ("post", f"{_BASE_REVIEW}/review", {"decision": "approved"}, 202),
        ("get", _DOCUMENT, None, 200),
        ("get", _IMAGES, None, 200),
    ],
)
def test_review_routes_share_catalog_ownership(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    body: dict[str, object] | None,
    owned_status: int,
) -> None:
    from api.routers.api.v1.document_annotation_ui import reviews as reviews_module
    from mistralai_capabilities.document_annotation_ui import (
        api as document_annotation_ui_module,
    )

    async def get_document(document_key: str) -> bytes:
        return b"document-bytes"

    monkeypatch.setattr(reviews_module, "get_document", get_document)

    async def get_document_image(document_key: str, image_id: str) -> bytes:
        return b"\x89PNG\r\n\x1a\nfake"

    monkeypatch.setattr(reviews_module, "get_document_image", get_document_image)
    # The ownership check moved behind `api.document_annotation_ui.owned_document_key`, so patch it where it is
    # looked up. The routes still share one guard, which is what this test is about.
    monkeypatch.setattr(document_annotation_ui_module, "is_owned_document", lambda document_key, user_id: True)
    state = _state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review")

    not_owned = TestClient(_app(FakeCommands(state))).request(method, path, headers=auth(), json=body)

    assert not_owned.status_code == 404
    assert not_owned.json() == {"detail": "Unknown execution"}

    owned = TestClient(_app(FakeCommands(state), _owned_executions())).request(method, path, headers=auth(), json=body)

    assert owned.status_code == owned_status


def test_review_image_streams_stored_bytes_with_a_sniffed_content_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routers.api.v1.document_annotation_ui import reviews as reviews_module
    from mistralai_capabilities.document_annotation_ui import (
        api as document_annotation_ui_module,
    )

    png = b"\x89PNG\r\n\x1a\n" + b"pixels"

    async def get_document_image(document_key: str, image_id: str) -> bytes:
        return png

    monkeypatch.setattr(reviews_module, "get_document_image", get_document_image)
    monkeypatch.setattr(document_annotation_ui_module, "is_owned_document", lambda document_key, user_id: True)
    state = _state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review")

    response = TestClient(_app(FakeCommands(state), _owned_executions())).get(_IMAGES, headers=auth())

    assert response.status_code == 200
    assert response.content == png
    assert response.headers["content-type"] == "image/png"


class _FailingOutcomeStore(FakeExecutionStore):
    async def set_outcome(self, *, execution_id: str, user_id: str, outcome: str) -> bool:
        raise RuntimeError("outcome store is unavailable")


def test_submit_review_still_succeeds_when_the_denormalization_persist_fails() -> None:
    # The update already made the decision authoritative, so a failed best-effort persist must not
    # 500 the request — get_review_state read-repairs the store on the next poll.
    commands = FakeCommands(_state(WorkflowRunStatus.PENDING_REVIEW, "extraction_review"))
    executions = _FailingOutcomeStore({(_EXECUTION_ID, USER_ID, DOCUMENT_ANNOTATION_UI_WORKFLOWS[0].name)})

    response = TestClient(_app(commands, executions)).post(
        f"{_BASE_REVIEW}/review", headers=auth(), json={"decision": "approved"}
    )

    assert response.status_code == 202
    assert commands.updates != []


def test_get_review_state_heals_a_missing_store_decision_from_the_workflow() -> None:
    # A persist that failed after the update leaves the run decided in the workflow but blank in the
    # store. get_review_state re-reads the decision from the workflow and re-persists it (read-repair).
    decided = DocumentReviewState(
        status=WorkflowRunStatus.COMPLETED,
        current_review_step=None,
        document_key=f"users/{USER_ID}/documents/review.pdf",
        review_decision="approved",
    )
    commands = FakeCommands(decided)
    executions = _owned_executions()

    response = TestClient(_app(commands, executions)).get(f"{_BASE_REVIEW}/review-state", headers=auth())

    assert response.status_code == 200
    assert response.json()["review_decision"] == "approved"
    assert executions.outcomes_by_owner == {(_EXECUTION_ID, USER_ID): "approved"}
