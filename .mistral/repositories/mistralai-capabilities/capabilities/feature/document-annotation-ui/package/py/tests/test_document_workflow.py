import asyncio
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, cast

import pytest
from mistralai_capabilities.document_annotation_ui import (
    workflow as document_workflow,
)
from mistralai_capabilities.document_annotation_ui.document_types import (
    DOCUMENT_TYPES,
    DocumentType,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    DocumentExtractionRequest,
    DocumentExtractionResponse,
    DocumentReviewState,
    ExtractedDocument,
    OcrBlockResult,
    OcrDocumentResult,
    OcrPageResult,
    ReviewOutcome,
    ReviewSignal,
    WorkflowRunStatus,
)
from mistralai_capabilities.document_annotation_ui.workflow import (
    DocumentExtractionWorkflow,
)
from mistralai_capabilities.document_annotation_ui.workflows_catalog import (
    DocumentAnnotationUiWorkflow,
)
from pydantic import ValidationError

WaitCondition = Callable[[Callable[[], bool]], Awaitable[None]]


class _Coercing(DocumentType):
    # A test-only registered model with a required string AND an optional coercing number, so the
    # model-path tests below still exercise coercion ("120" -> 120.0) and per-field errors — the
    # shipped starter type (`Example`, title-only) has no numeric field to drive that.
    title: str
    amount: float | None = None


@pytest.fixture(autouse=True)
def model_type() -> Any:
    DOCUMENT_TYPES["_coercing"] = _Coercing
    try:
        yield
    finally:
        DOCUMENT_TYPES.pop("_coercing", None)


def _ocr_result() -> OcrDocumentResult:
    return OcrDocumentResult(
        ocr_text="Acme statement\n\nTotal 120.00",
        page_count=1,
        page_confidences=[0.99],
        pages=[
            OcrPageResult(
                index=0,
                width=800,
                height=1000,
                blocks=[
                    OcrBlockResult(
                        content="Acme statement total 120.00",
                        type="text",
                        top_left_x=1,
                        top_left_y=2,
                        bottom_right_x=3,
                        bottom_right_y=4,
                    )
                ],
                image_ids=["img-1"],
            )
        ],
    )


def _document(title: str = "Acme", amount: float = 120.0) -> ExtractedDocument:
    return ExtractedDocument(
        data={"title": title, "amount": amount},
        sources={"title": ["source_0"], "amount": ["source_0"]},
    )


DOCUMENT_KEY = "document_annotation_ui/documents/2f1c/document.pdf"


def _request(**overrides: Any) -> DocumentExtractionRequest:
    fields: dict[str, Any] = {
        "document_key": DOCUMENT_KEY,
        "file_name": "document.pdf",
        "mime_type": "application/pdf",
        "schema_name": "_coercing",
        "prompt": "Acme",
    }
    fields.update(overrides)
    return DocumentExtractionRequest(**fields)


def _model_request() -> DocumentExtractionRequest:
    return _request()


def _workflow_metadata(
    review_step: str | None = "extraction_review",
) -> DocumentAnnotationUiWorkflow:
    return DocumentAnnotationUiWorkflow(
        name="document_annotation_ui_document_extraction",
        display_name="Document Extraction",
        description="Test workflow metadata.",
        review_step=review_step,
        show_debug=True,
        route_segment="document",
    )


async def _run_until_review(
    monkeypatch: pytest.MonkeyPatch,
    *,
    extracted: ExtractedDocument | None = None,
    request: DocumentExtractionRequest | None = None,
) -> tuple[DocumentExtractionWorkflow, asyncio.Task[DocumentExtractionResponse]]:
    run_request = request or _request()
    wait_started = asyncio.Event()

    async def fake_ocr(
        document_key: str | None = None,
        file_name: str | None = None,
        mime_type: str | None = None,
    ) -> OcrDocumentResult:
        assert (document_key, file_name, mime_type) == (
            DOCUMENT_KEY,
            "document.pdf",
            "application/pdf",
        )
        return _ocr_result()

    async def fake_extract(
        pages: list[OcrPageResult],
        schema_name: str,
        prompt: str,
        expected_schema: dict[str, object],
    ) -> ExtractedDocument:
        assert pages[0].blocks[0].content == "Acme statement total 120.00"
        assert schema_name == "_coercing"
        assert expected_schema == _Coercing.model_json_schema()
        assert isinstance(prompt, str) and prompt
        return extracted or _document()

    async def wait_for_review(predicate: Callable[[], bool]) -> None:
        wait_started.set()
        for _ in range(1_000):
            if predicate():
                return
            await asyncio.sleep(0)
        raise TimeoutError("workflow did not receive review_result or cancel_requested")

    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_ocr",
        fake_ocr,
    )
    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_extract",
        fake_extract,
    )
    monkeypatch.setattr(document_workflow.workflows.workflow, "wait_condition", wait_for_review)

    workflow = DocumentExtractionWorkflow()
    task = asyncio.create_task(cast(Coroutine[Any, Any, DocumentExtractionResponse], workflow.run(run_request)))
    await asyncio.wait_for(wait_started.wait(), timeout=1)
    return workflow, task


@pytest.mark.asyncio
async def test_document_workflow_happy_path_waits_for_review_and_returns_reviewed_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow, task = await _run_until_review(monkeypatch)

    state = DocumentReviewState.model_validate(workflow.review_state())
    assert state.status == WorkflowRunStatus.PENDING_REVIEW
    assert state.current_review_step == "extraction_review"
    assert state.extracted == _document()
    assert state.ocr == _ocr_result()
    assert state.extraction_schema == _Coercing.model_json_schema()
    assert state.schema_name == "_coercing"
    assert state.document_key == DOCUMENT_KEY
    assert state.file_name == "document.pdf"
    assert state.mime_type == "application/pdf"
    assert state.prompt == "Acme"
    assert state.validation_errors == []

    await workflow.review_result(
        ReviewSignal(
            step="extraction_review",
            decision="approved",
            reviewed_output={
                "data": {"title": "Edited Supplier", "amount": 125.0},
                "_sources": {"title": ["source_1"]},
            },
            note="corrected",
            reviewed_by="reviewer-1",
        )
    )

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.decision == "approved"
    assert response.extracted == ExtractedDocument(
        data={"title": "Edited Supplier", "amount": 125.0},
        sources={"title": ["source_1"]},
    )
    final_state = DocumentReviewState.model_validate(workflow.review_state())
    assert final_state.status == WorkflowRunStatus.COMPLETED
    assert final_state.current_review_step is None
    assert final_state.document_key == DOCUMENT_KEY
    assert final_state.review_decision == "approved"


@pytest.mark.asyncio
async def test_document_workflow_on_the_model_path_publishes_the_resolved_schema(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    # given a run that names a registered document type
    workflow, task = await _run_until_review(monkeypatch, request=_model_request())

    # then review_state publishes the schema the model resolved to
    state = DocumentReviewState.model_validate(workflow.review_state())
    assert state.schema_name == "_coercing"
    assert state.extraction_schema == _Coercing.model_json_schema()
    assert state.prompt == "Acme"

    await workflow.review_result(ReviewSignal(step="extraction_review", decision="approved"))
    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED


@pytest.mark.asyncio
async def test_document_workflow_rejects_an_approved_edit_that_fails_the_document_type(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    # given a paused run bound to the model
    workflow, task = await _run_until_review(monkeypatch, request=_model_request())

    # when an approved edit carries a value the schema cannot accept
    outcome = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output={"data": {"title": "Acme", "amount": "not a number"}},
                reviewed_by="reviewer-1",
            )
        )
    )

    # then the update reports the field errors and records nothing
    assert outcome.accepted is False
    assert outcome.reason == "invalid"
    assert [error.path for error in outcome.validation_errors] == ["amount"]
    assert workflow._reviews == {}
    assert not task.done()

    state = DocumentReviewState.model_validate(workflow.review_state())
    assert state.status == WorkflowRunStatus.PENDING_REVIEW
    assert state.current_review_step == "extraction_review"
    assert [error.path for error in state.validation_errors] == ["amount"]

    # and the human can resubmit a valid edit against the still-open gate
    accepted = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output={"data": {"title": "Acme", "amount": 130.0}},
                reviewed_by="reviewer-1",
            )
        )
    )
    assert accepted.accepted is True
    assert accepted.reason is None
    assert accepted.validation_errors == []

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.extracted is not None
    assert response.extracted.data == {"title": "Acme", "amount": 130.0}
    assert DocumentReviewState.model_validate(workflow.review_state()).validation_errors == []


@pytest.mark.asyncio
async def test_document_workflow_persists_the_coerced_reviewed_values(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    # given a paused run bound to the model
    workflow, task = await _run_until_review(monkeypatch, request=_model_request())

    # when the reviewer submits a numeric field as a string the model can parse
    outcome = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output={"data": {"title": "Acme", "amount": "120"}},
            )
        )
    )
    assert outcome.accepted is True

    # then the stored result carries the coerced float, not the submitted string
    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.extracted is not None
    amount = response.extracted.data["amount"]
    assert amount == 120.0
    assert isinstance(amount, float)


@pytest.mark.asyncio
async def test_document_workflow_refuses_to_approve_an_invalid_extraction_as_is(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    # A real extraction is SDK-validated. This invalid activity double verifies that approval still
    # validates data entering from the human-review boundary.
    invalid = ExtractedDocument(data={"title": "Acme", "amount": "not a number"}, sources={})
    workflow, task = await _run_until_review(monkeypatch, extracted=invalid, request=_model_request())

    # when the human approves WITHOUT editing (reviewed_output is None)
    outcome = ReviewOutcome.model_validate(
        await workflow.review_result(ReviewSignal(step="extraction_review", decision="approved"))
    )

    # then the approval is refused, nothing is recorded, and the run stays parked with its errors
    assert outcome.accepted is False
    assert outcome.reason == "invalid"
    assert [error.path for error in outcome.validation_errors] == ["amount"]
    assert workflow._reviews == {}
    assert not task.done()
    state = DocumentReviewState.model_validate(workflow.review_state())
    assert state.status == WorkflowRunStatus.PENDING_REVIEW
    assert [error.path for error in state.validation_errors] == ["amount"]

    # cancel to unwind the still-parked run
    await workflow.cancel_requested()
    await asyncio.wait_for(task, timeout=1)


@pytest.mark.asyncio
async def test_document_workflow_rejects_a_malformed_reviewed_output_without_wedging(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    # given a paused run bound to the model
    workflow, task = await _run_until_review(monkeypatch, request=_model_request())

    # when an approved submission carries a structurally malformed reviewed_output
    outcome = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output={"data": 12345},
            )
        )
    )

    # then it is rejected (not raised), the run is not wedged, and a valid resubmit still completes it
    assert outcome.accepted is False
    assert outcome.reason == "invalid"
    assert workflow._reviews == {}
    assert not task.done()

    await workflow.review_result(
        ReviewSignal(
            step="extraction_review",
            decision="approved",
            reviewed_output={"data": {"title": "Acme", "amount": 5.0}},
        )
    )
    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED


@pytest.mark.asyncio
async def test_document_workflow_rejects_review_after_schema_drift(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    class Changed(DocumentType):
        title: str
        reference: str

    workflow, task = await _run_until_review(monkeypatch, request=_model_request())
    monkeypatch.setitem(DOCUMENT_TYPES, "_coercing", Changed)

    outcome = ReviewOutcome.model_validate(
        await workflow.review_result(ReviewSignal(step="extraction_review", decision="approved"))
    )

    assert outcome.accepted is False
    assert outcome.reason == "schema_changed"
    assert not task.done()

    await workflow.cancel_requested()
    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.CANCELLED


@pytest.mark.asyncio
async def test_document_workflow_rejects_review_after_schema_removal(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    workflow, task = await _run_until_review(monkeypatch, request=_model_request())
    monkeypatch.delitem(DOCUMENT_TYPES, "_coercing")

    outcome = ReviewOutcome.model_validate(
        await workflow.review_result(ReviewSignal(step="extraction_review", decision="approved"))
    )

    assert outcome.accepted is False
    assert outcome.reason == "schema_changed"
    assert not task.done()

    await workflow.cancel_requested()
    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.CANCELLED


@pytest.mark.asyncio
async def test_document_workflow_review_signal_before_gate_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A review delivered before the run reaches PENDING_REVIEW — e.g. through the generic
    # execution-signal route rather than the guarded submit_review endpoint — must not pre-seed the
    # gate. Without the workflow-side guard it would sit in `_reviews` and be consumed the instant
    # the gate is first evaluated, skipping the human review entirely.
    wait_started = asyncio.Event()

    async def fake_ocr(**_kwargs: Any) -> OcrDocumentResult:
        return _ocr_result()

    async def fake_extract(*_args: Any, **_kwargs: Any) -> ExtractedDocument:
        return _document()

    async def wait_for_review(predicate: Callable[[], bool]) -> None:
        wait_started.set()
        for _ in range(1_000):
            if predicate():
                return
            await asyncio.sleep(0)
        raise TimeoutError("workflow did not receive review_result or cancel_requested")

    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_ocr",
        fake_ocr,
    )
    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_extract",
        fake_extract,
    )
    monkeypatch.setattr(document_workflow.workflows.workflow, "wait_condition", wait_for_review)

    workflow = DocumentExtractionWorkflow()

    # Fired while the run is still RUNNING (the status set in __init__): the guard drops it.
    await workflow.review_result(ReviewSignal(step="extraction_review", decision="approved", reviewed_by="attacker"))

    task = asyncio.create_task(cast(Coroutine[Any, Any, DocumentExtractionResponse], workflow.run(_request())))
    await asyncio.wait_for(wait_started.wait(), timeout=1)

    # The gate is reached but the pre-seed did not satisfy it: the run still awaits a review.
    assert not task.done()
    assert DocumentReviewState.model_validate(workflow.review_state()).status == WorkflowRunStatus.PENDING_REVIEW

    # A properly timed review now drives the run to completion.
    await workflow.review_result(ReviewSignal(step="extraction_review", decision="rejected", reviewed_by="reviewer-1"))
    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.REJECTED


@pytest.mark.asyncio
async def test_document_workflow_with_no_review_step_completes_without_pausing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_ocr(**_kwargs: Any) -> OcrDocumentResult:
        return _ocr_result()

    async def fake_extract(
        pages: list[OcrPageResult],
        schema_name: str,
        prompt: str,
        expected_schema: dict[str, object],
    ) -> ExtractedDocument:
        assert expected_schema == _Coercing.model_json_schema()
        return _document("AI", 100.0)

    async def fail_if_waiting(_predicate: Callable[[], bool]) -> None:
        raise AssertionError("zero-review workflow should not pause")

    monkeypatch.setattr(document_workflow, "default_workflow", lambda: _workflow_metadata(None))
    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_ocr",
        fake_ocr,
    )
    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_extract",
        fake_extract,
    )
    monkeypatch.setattr(document_workflow.workflows.workflow, "wait_condition", fail_if_waiting)

    workflow = DocumentExtractionWorkflow()
    response = DocumentExtractionResponse.model_validate(await workflow.run(_request()))

    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.decision is None
    assert response.extracted == _document("AI", 100.0)
    final_state = DocumentReviewState.model_validate(workflow.review_state())
    assert final_state.status == WorkflowRunStatus.COMPLETED
    assert final_state.current_review_step is None
    assert final_state.extracted == _document("AI", 100.0)
    assert final_state.review_decision is None


@pytest.mark.asyncio
async def test_document_workflow_review_state_carries_the_document_reference_before_ocr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ocr_started = asyncio.Event()
    seen: dict[str, str | None] = {}

    async def capture_during_ocr(**_kwargs: Any) -> OcrDocumentResult:
        state = DocumentReviewState.model_validate(workflow.review_state())
        seen["document_key"] = state.document_key
        seen["file_name"] = state.file_name
        seen["mime_type"] = state.mime_type
        ocr_started.set()
        raise TimeoutError("stop after ocr")

    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_ocr",
        capture_during_ocr,
    )

    workflow = DocumentExtractionWorkflow()
    with pytest.raises(TimeoutError, match="stop after ocr"):
        await workflow.run(_request())

    assert ocr_started.is_set()
    assert seen == {
        "document_key": DOCUMENT_KEY,
        "file_name": "document.pdf",
        "mime_type": "application/pdf",
    }


@pytest.mark.asyncio
async def test_document_workflow_approve_without_edits_falls_back_to_extracted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow, task = await _run_until_review(monkeypatch, extracted=_document("Original", 88.0))

    await workflow.review_result(ReviewSignal(step="extraction_review", decision="approved"))

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.decision == "approved"
    assert response.extracted == _document("Original", 88.0)


@pytest.mark.asyncio
async def test_document_workflow_rejected_review_finishes_rejected_without_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow, task = await _run_until_review(monkeypatch)

    await workflow.review_result(ReviewSignal(step="extraction_review", decision="rejected", note="wrong extraction"))

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.REJECTED
    assert response.decision == "rejected"
    assert response.extracted is None
    assert DocumentReviewState.model_validate(workflow.review_state()).status == WorkflowRunStatus.REJECTED


@pytest.mark.asyncio
async def test_document_workflow_keeps_the_first_decision_when_a_second_signal_arrives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A duplicate signal — a double-submit that raced the API guard, or a retried POST — must not
    # overwrite the decision the run already recorded: first writer wins. Were it last-write-wins,
    # the trailing rejection would flip an approved run.
    workflow, task = await _run_until_review(monkeypatch, extracted=_document("Original", 88.0))

    first = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output=None,
                note="first",
                reviewed_by="reviewer-1",
            )
        )
    )
    second = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="rejected",
                reviewed_output=None,
                note="second",
                reviewed_by="reviewer-2",
            )
        )
    )
    assert first.decision == "approved"
    assert second.decision == "approved"

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.decision == "approved"
    assert response.extracted == _document("Original", 88.0)


@pytest.mark.asyncio
async def test_document_workflow_returns_the_first_decision_for_a_duplicate_that_is_now_invalid(
    monkeypatch: pytest.MonkeyPatch,
    model_type: None,
) -> None:
    # A duplicate that lands before wait_condition resumes must be answered with the recorded
    # decision even when its own body would fail validation: the run is already bound, so the
    # handler must not re-validate the duplicate into a spurious accepted=False.
    workflow, task = await _run_until_review(monkeypatch, request=_model_request())

    first = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output={"data": {"title": "Acme", "amount": 5.0}},
            )
        )
    )
    second = ReviewOutcome.model_validate(
        await workflow.review_result(
            ReviewSignal(
                step="extraction_review",
                decision="approved",
                reviewed_output={"data": {"title": "Acme", "amount": "not a number"}},
            )
        )
    )

    assert first.accepted is True
    assert second.accepted is True
    assert second.reason is None
    assert second.validation_errors == []
    assert second.decision == "approved"

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.COMPLETED
    assert response.extracted is not None
    assert response.extracted.data == {"title": "Acme", "amount": 5.0}


@pytest.mark.asyncio
async def test_document_workflow_cancel_requested_before_review_returns_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow, task = await _run_until_review(monkeypatch)

    await workflow.cancel_requested()

    response = DocumentExtractionResponse.model_validate(await asyncio.wait_for(task, timeout=1))
    assert response.status == WorkflowRunStatus.CANCELLED
    assert response.decision is None
    assert response.extracted is None
    final_state = DocumentReviewState.model_validate(workflow.review_state())
    assert final_state.status == WorkflowRunStatus.CANCELLED
    assert final_state.current_review_step is None


@pytest.mark.asyncio
async def test_document_workflow_wait_condition_can_fail_when_review_is_withheld(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Proves the workflow remains blocked on R2's review gate (R2 lines 96-102) until signalled.
    async def fake_ocr(**_kwargs: Any) -> OcrDocumentResult:
        return _ocr_result()

    async def fake_extract(
        pages: list[OcrPageResult],
        schema_name: str,
        prompt: str,
        expected_schema: dict[str, object],
    ) -> ExtractedDocument:
        assert expected_schema == _Coercing.model_json_schema()
        return _document()

    async def failing_wait(predicate: Callable[[], bool]) -> None:
        assert predicate() is False
        await asyncio.sleep(0)
        assert predicate() is False
        raise TimeoutError("review signal withheld")

    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_ocr",
        fake_ocr,
    )
    monkeypatch.setattr(
        document_workflow.activities,
        "document_annotation_ui_document_extract",
        fake_extract,
    )
    monkeypatch.setattr(document_workflow.workflows.workflow, "wait_condition", failing_wait)

    with pytest.raises(TimeoutError, match="review signal withheld"):
        await DocumentExtractionWorkflow().run(_request())


@pytest.mark.asyncio
async def test_document_workflow_without_any_transport_errors_before_ocr() -> None:
    no_transport = DocumentExtractionRequest.model_construct(
        schema_name="_coercing",
        document_key=None,
    )

    with pytest.raises(ValueError, match="document_key from the upload route"):
        await DocumentExtractionWorkflow().run(no_transport)


@pytest.mark.asyncio
async def test_request_requires_a_registered_schema_name() -> None:
    with pytest.raises(ValidationError, match="schema_name"):
        DocumentExtractionRequest(document_key=DOCUMENT_KEY)

    # The registry lookup is the workflow's job, so an unregistered name fails there, before OCR.
    unknown = DocumentExtractionRequest(document_key=DOCUMENT_KEY, schema_name="not_a_document_type")
    with pytest.raises(ValueError, match="Unknown document type"):
        await DocumentExtractionWorkflow().run(unknown)
