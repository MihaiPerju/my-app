"""Shared Python contract for schema-driven document extraction."""

import re
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

__all__ = [
    "FALLBACK_MIME_TYPE",
    "MAX_DOCUMENT_BYTES",
    "DocumentExtractionRequest",
    "DocumentExtractionResponse",
    "DocumentReviewState",
    "ExtractedDocument",
    "OcrBlockResult",
    "OcrDocumentResult",
    "OcrPageResult",
    "ReviewDecision",
    "ReviewOutcome",
    "ReviewSignal",
    "SchemaFieldError",
    "UploadResult",
    "WorkflowRunStatus",
    "safe_media_type",
]


class SchemaFieldError(BaseModel):
    path: str
    message: str


_TRANSPORT_ERROR = "Provide a document_key from the upload route"

# Storage-backed cap: the bytes go to object storage, so only the upload request carries
# them and the run payload holds a key.
MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

FALLBACK_MIME_TYPE = "application/octet-stream"

_MEDIA_TYPE_TOKEN = r"[A-Za-z0-9.+_-]+"
_MEDIA_TYPE_RE = re.compile(
    rf"\A{_MEDIA_TYPE_TOKEN}/{_MEDIA_TYPE_TOKEN}(?:[ \t]*;[ \t]*{_MEDIA_TYPE_TOKEN}={_MEDIA_TYPE_TOKEN})*\Z"
)


def safe_media_type(value: str | None) -> str:
    """The value if it is a well-formed media type, else the octet-stream fallback.

    mime_type is caller-controlled. A hostile value breaks two sinks: the OCR data-URL, where a
    comma ends the metadata early, and the review Content-Type header, where a CR/LF splits the
    response. The grammar admits type/subtype with optional "; key=token" parameters and nothing
    else. This makes the result safe in both places.
    """
    return value if value and _MEDIA_TYPE_RE.match(value) else FALLBACK_MIME_TYPE


class WorkflowRunStatus(StrEnum):
    RUNNING = "running"
    PENDING_REVIEW = "pending_review"
    COMPLETED = "completed"
    REJECTED = "rejected"
    FAILED = "failed"
    RETRIED = "retried"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"


class ReviewDecision(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ReviewSignal(BaseModel):
    """Payload delivered via the ``review_result`` Temporal update.

    ``step`` must match the ``current_review_step`` the workflow is publishing on its
    ``review_state`` query, so it routes to the correct ``wait_condition``.
    """

    step: str
    decision: ReviewDecision
    reviewed_output: dict[str, Any] | None = None
    note: str | None = None
    reviewed_by: str | None = None


class ReviewOutcome(BaseModel):
    """What the ``review_result`` update returns: whether the run accepted the submission, and the
    decision it is now bound to. ``decision`` is the FIRST writer's, so two concurrent submits read
    back the same value — the caller persists exactly what the run accepted, never its own guess.
    """

    accepted: bool
    decision: ReviewDecision | None = None
    reason: str | None = None
    validation_errors: list[SchemaFieldError] = Field(default_factory=list)


class OcrBlockResult(BaseModel):
    """A single OCR region detected on a page."""

    content: str
    type: str
    top_left_x: int
    top_left_y: int
    bottom_right_x: int
    bottom_right_y: int


class OcrPageResult(BaseModel):
    """OCR results for one page of a document."""

    index: int
    width: int
    height: int
    blocks: list[OcrBlockResult]
    # Ids of this page's OCR images, in order; the bytes live in object storage (see
    # ``storage.document_image_key``) and are fetched on demand, never carried in workflow state.
    image_ids: list[str] = []


class OcrDocumentResult(BaseModel):
    """Full OCR output for a document.

    Returned by the OCR activity and published on the workflow review_state query. The frontend
    reads ocr_text, pages, and page_confidences.
    """

    ocr_text: str
    page_count: int
    page_confidences: list[float] | None = None
    pages: list[OcrPageResult] = []


class DocumentExtractionRequest(BaseModel):
    """Input to ``document_annotation_ui_document_extraction``.

    The document travels as a document_key from the upload route, the only transport. OCR needs the
    mime_type to build its data URL.
    """

    schema_name: str
    prompt: str | None = None
    document_key: str | None = Field(
        default=None,
        description="Object-storage key returned by the document upload route.",
    )
    file_name: str | None = Field(default=None, description="Display filename for the uploaded document.")
    mime_type: str | None = Field(default=None, description="MIME type used to build the OCR data URL.")

    @model_validator(mode="after")
    def _validate(self) -> Self:
        if not self.document_key:
            raise ValueError(_TRANSPORT_ERROR)
        # Normalize here, at the model boundary, not only on the upload route: a client can start a
        # run with an arbitrary mime_type in this body without ever calling upload, and it is this
        # field the OCR activity puts into its data URL. Coercing an odd value to octet-stream closes
        # that sink for every construction path.
        self.mime_type = safe_media_type(self.mime_type) if self.mime_type is not None else None
        return self


class UploadResult(BaseModel):
    """What the document upload route hands back to the caller of an extraction run."""

    document_key: str
    file_name: str
    mime_type: str
    size: int


class ExtractedDocument(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data: dict[str, Any] = Field(default_factory=dict)
    sources: dict[str, list[str]] = Field(default_factory=dict, alias="_sources")


class DocumentExtractionResponse(BaseModel):
    status: str
    decision: str | None = None
    extracted: ExtractedDocument | None = None


class DocumentReviewState(BaseModel):
    """What a run reports to the review screen, including where its document still lives.

    The document reference is the run's own copy of the request transport fields, so a review can be
    reopened: the content route reads the storage key server-side, never from the caller.

    All three fields are optional because a run can have none. The query can answer before _run
    records them, and old runs never had them, so the content route answers 404.
    """

    status: WorkflowRunStatus
    current_review_step: str | None = None
    extracted: ExtractedDocument | None = None
    ocr: OcrDocumentResult | None = None
    extraction_schema: dict[str, Any] | None = None
    schema_name: str | None = None
    prompt: str | None = None
    validation_errors: list[SchemaFieldError] = Field(default_factory=list)
    document_key: str | None = None
    file_name: str | None = None
    mime_type: str | None = None
    review_decision: ReviewDecision | None = None
