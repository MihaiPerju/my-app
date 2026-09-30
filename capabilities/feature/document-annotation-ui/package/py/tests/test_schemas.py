import pytest
from mistralai_capabilities.document_annotation_ui.schemas import (
    FALLBACK_MIME_TYPE,
    MAX_DOCUMENT_BYTES,
    DocumentExtractionRequest,
    DocumentReviewState,
    ExtractedDocument,
    OcrBlockResult,
    OcrDocumentResult,
    OcrPageResult,
    ReviewOutcome,
    ReviewSignal,
    SchemaFieldError,
    UploadResult,
    WorkflowRunStatus,
    safe_media_type,
)
from pydantic import ValidationError

SAMPLE_EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "amount": {"type": "number"},
    },
    "required": ["title"],
}


def test_workflow_run_status_covers_every_execution_status_the_listing_can_report() -> None:
    # `retried` and `cancelling` are unreachable from this workflow — it never sets them. They
    # exist because the reviews list renders AI Studio execution statuses through
    # `EXECUTION_STATUS_ALIASES` (package/ts/src/lib.ts), which maps `retrying_after_error` and
    # `cancelling` onto this enum. Dropping either breaks the exhaustive badge map.
    assert [(member.name, member.value) for member in WorkflowRunStatus] == [
        ("RUNNING", "running"),
        ("PENDING_REVIEW", "pending_review"),
        ("COMPLETED", "completed"),
        ("REJECTED", "rejected"),
        ("FAILED", "failed"),
        ("RETRIED", "retried"),
        ("CANCELLING", "cancelling"),
        ("CANCELLED", "cancelled"),
    ]


def test_review_signal_carries_the_reviewer_decision_and_edits() -> None:
    signal = ReviewSignal(
        step="extraction_review",
        decision="approved",
        reviewed_output={"data": {"title": "Acme"}},
        note="looks good",
        reviewed_by="user-1",
    )

    assert signal.reviewed_output == {"data": {"title": "Acme"}}
    assert signal.note == "looks good"
    assert signal.reviewed_by == "user-1"


def test_ocr_models_keep_frontend_output_shape() -> None:
    # R2 mistral_idp_sdk/models.py:97-130
    block = OcrBlockResult(
        content="Total 120.00",
        type="text",
        top_left_x=1,
        top_left_y=2,
        bottom_right_x=3,
        bottom_right_y=4,
    )
    page = OcrPageResult(index=0, width=800, height=1000, blocks=[block], image_ids=["img-1"])
    document = OcrDocumentResult(
        ocr_text="Total 120.00",
        page_count=1,
        page_confidences=[0.99],
        pages=[page],
    )

    assert document.pages[0].blocks[0].bottom_right_y == 4
    # Image bytes live in object storage; the model carries only their ids per page.
    assert document.pages[0].image_ids == ["img-1"]
    assert not hasattr(document, "images")


def test_extracted_document_round_trips_data_and_sources_alias() -> None:
    document = ExtractedDocument.model_validate(
        {
            "data": {"title": "Acme", "amount": 120.0},
            "_sources": {"title": ["source_0"], "amount": ["source_3"]},
        }
    )

    assert document.data == {"title": "Acme", "amount": 120.0}
    assert document.sources == {"title": ["source_0"], "amount": ["source_3"]}
    assert document.model_dump(by_alias=True)["_sources"] == document.sources
    assert ExtractedDocument.model_validate({"sources": {"amount": ["source_4"]}}).sources == {"amount": ["source_4"]}


def test_document_extraction_request_takes_a_document_key_as_the_primary_transport() -> None:
    request = DocumentExtractionRequest(
        document_key="document_annotation_ui/documents/2f1c/statement.pdf",
        file_name="statement.pdf",
        mime_type="application/pdf",
        schema_name="example",
    )

    assert request.document_key == "document_annotation_ui/documents/2f1c/statement.pdf"
    assert request.file_name == "statement.pdf"
    assert request.mime_type == "application/pdf"


def test_document_extraction_request_requires_a_document_key() -> None:
    with pytest.raises(ValidationError, match="document_key from the upload route"):
        DocumentExtractionRequest(schema_name="example")


def test_upload_result_carries_the_stored_document_reference() -> None:
    result = UploadResult(
        document_key="document_annotation_ui/documents/2f1c/statement.pdf",
        file_name="statement.pdf",
        mime_type="application/pdf",
        size=2048,
    )

    assert result.model_dump() == {
        "document_key": "document_annotation_ui/documents/2f1c/statement.pdf",
        "file_name": "statement.pdf",
        "mime_type": "application/pdf",
        "size": 2048,
    }


def test_max_document_bytes_is_the_storage_backed_cap() -> None:
    assert MAX_DOCUMENT_BYTES == 20 * 1024 * 1024


def test_document_review_state_carries_schema_for_the_review_ui() -> None:
    state = DocumentReviewState(
        status=WorkflowRunStatus.PENDING_REVIEW,
        current_review_step="extraction_review",
        extracted=ExtractedDocument(data={"title": "Acme"}),
        extraction_schema=SAMPLE_EXTRACTION_SCHEMA,
    )

    assert state.extraction_schema == SAMPLE_EXTRACTION_SCHEMA
    assert state.extracted == ExtractedDocument(data={"title": "Acme"})


def test_document_review_state_carries_the_stored_document_reference() -> None:
    # R2 exposed the document as a `content_url` on the run, so reopening a review refetched the
    # bytes rather than depending on a handle the tab happened to still hold. This capability's
    # equivalent is the storage key on the review state: the content route reads it back off this
    # query and never trusts a client-supplied one.
    state = DocumentReviewState(
        status=WorkflowRunStatus.PENDING_REVIEW,
        current_review_step="extraction_review",
        document_key="document_annotation_ui/documents/2f1c/statement.pdf",
        file_name="statement.pdf",
        mime_type="application/pdf",
    )

    assert state.document_key == "document_annotation_ui/documents/2f1c/statement.pdf"
    assert state.file_name == "statement.pdf"
    assert state.mime_type == "application/pdf"


def test_document_review_state_document_reference_is_optional() -> None:
    # A run started before the key was recorded — or one whose transport was platform-injected
    # `documents` rather than a key — still validates; the content route answers 404 for it.
    state = DocumentReviewState(status=WorkflowRunStatus.RUNNING)

    assert state.document_key is None
    assert state.file_name is None
    assert state.mime_type is None


def test_request_accepts_schema_name_alone() -> None:
    request = DocumentExtractionRequest(document_key="k", schema_name="example")

    assert request.schema_name == "example"


def test_request_requires_a_schema_name() -> None:
    with pytest.raises(ValidationError, match="schema_name"):
        DocumentExtractionRequest(document_key="k")


def test_request_no_longer_has_hint_field() -> None:
    assert "hint" not in DocumentExtractionRequest.model_fields
    assert "prompt" in DocumentExtractionRequest.model_fields
    assert "extraction_schema" not in DocumentExtractionRequest.model_fields


def test_review_state_no_longer_has_hint_field() -> None:
    assert "hint" not in DocumentReviewState.model_fields
    assert "prompt" in DocumentReviewState.model_fields
    assert "schema_name" in DocumentReviewState.model_fields
    assert "validation_errors" in DocumentReviewState.model_fields


def test_review_outcome_round_trips_reason_and_errors() -> None:
    outcome = ReviewOutcome(
        accepted=False,
        reason="invalid",
        validation_errors=[SchemaFieldError(path="amount", message="Input should be a valid number")],
    )

    assert outcome.reason == "invalid"
    assert outcome.validation_errors[0].path == "amount"


def test_review_outcome_old_shape_still_validates() -> None:
    outcome = ReviewOutcome.model_validate({"accepted": True, "decision": "approved"})

    assert outcome.accepted is True
    assert outcome.reason is None
    assert outcome.validation_errors == []


@pytest.mark.parametrize(
    "value",
    [
        "application/pdf",
        "image/png",
        "text/plain; charset=utf-8",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
)
def test_safe_media_type_keeps_a_well_formed_type(value: str) -> None:
    assert safe_media_type(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "text/plain,garbage",
        "text/plain\r\nX-Injected: 1",
        'application/json"; drop',
        "not-a-media-type",
        "",
        None,
    ],
)
def test_safe_media_type_falls_back_on_anything_odd(value: str | None) -> None:
    assert safe_media_type(value) == FALLBACK_MIME_TYPE


def test_request_coerces_a_comma_bearing_mime_type_to_the_fallback() -> None:
    request = DocumentExtractionRequest(document_key="k", schema_name="example", mime_type="text/plain,garbage")

    assert request.mime_type == FALLBACK_MIME_TYPE


def test_request_preserves_a_well_formed_mime_type() -> None:
    request = DocumentExtractionRequest(document_key="k", schema_name="example", mime_type="application/pdf")

    assert request.mime_type == "application/pdf"


def test_request_leaves_an_absent_mime_type_as_none() -> None:
    request = DocumentExtractionRequest(document_key="k", schema_name="example")

    assert request.mime_type is None
