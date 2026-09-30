import mistralai.workflows as workflows
from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    from mistralai_capabilities.document_annotation_ui import activities
    from mistralai_capabilities.document_annotation_ui.env_contract import (
        check_document_annotation_ui_env,
    )
    from mistralai_capabilities.document_annotation_ui.schemas import (
        DocumentExtractionRequest,
        DocumentExtractionResponse,
        DocumentReviewState,
        ExtractedDocument,
        OcrDocumentResult,
        ReviewDecision,
        ReviewOutcome,
        ReviewSignal,
        SchemaFieldError,
        WorkflowRunStatus,
    )
    from mistralai_capabilities.document_annotation_ui.validation import (
        DocumentTypeChangedError,
        ValidationResult,
        resolve_document_type,
        validate_document_type,
    )
    from mistralai_capabilities.document_annotation_ui.workflows_catalog import (
        default_workflow,
    )
    from pydantic import ValidationError

# Fail at worker startup if required environment fields are missing.
check_document_annotation_ui_env()

_DEFAULT_WORKFLOW = default_workflow()


@workflows.workflow.define(
    name=_DEFAULT_WORKFLOW.name,
    workflow_display_name=_DEFAULT_WORKFLOW.display_name,
    workflow_description=_DEFAULT_WORKFLOW.description,
)
class DocumentExtractionWorkflow:
    def __init__(self) -> None:
        self._reviews: dict[str, ReviewSignal] = {}
        self._cancel_requested = False
        self._status = WorkflowRunStatus.RUNNING
        self._current_review_step: str | None = None
        self._extracted: ExtractedDocument | None = None
        self._ocr: OcrDocumentResult | None = None
        self._extraction_schema: dict[str, object] | None = None
        self._schema_name: str | None = None
        self._prompt: str | None = None
        self._validation_errors: list[SchemaFieldError] = []
        self._document_key: str | None = None
        self._file_name: str | None = None
        self._mime_type: str | None = None
        self._review_decision: ReviewDecision | None = None

    def _validate_data(self, data: dict[str, object]) -> ValidationResult:
        assert self._schema_name is not None
        assert self._extraction_schema is not None
        return validate_document_type(
            self._schema_name,
            data,
            expected_schema=self._extraction_schema,
        )

    @workflows.workflow.update(name="review_result")
    async def review_result(self, data: ReviewSignal) -> ReviewOutcome:
        # Do not let early or stale updates pre-seed the review gate.
        if (
            self._status != WorkflowRunStatus.PENDING_REVIEW
            or data.step != self._current_review_step
        ):
            return ReviewOutcome(accepted=False)
        # A duplicate can arrive before wait_condition resumes; the first writer wins.
        if data.step in self._reviews:
            return ReviewOutcome(
                accepted=True, decision=self._reviews[data.step].decision
            )

        if data.decision == ReviewDecision.APPROVED:
            try:
                proposed = (
                    ExtractedDocument.model_validate(data.reviewed_output).data
                    if data.reviewed_output is not None
                    else (self._extracted.data if self._extracted else {})
                )
            except ValidationError:
                return ReviewOutcome(
                    accepted=False,
                    reason="invalid",
                    validation_errors=[
                        SchemaFieldError(
                            path="", message="reviewed_output is malformed"
                        )
                    ],
                )
            try:
                result = self._validate_data(proposed)
            except DocumentTypeChangedError:
                return ReviewOutcome(accepted=False, reason="schema_changed")
            if result.errors:
                self._validation_errors = result.errors
                return ReviewOutcome(
                    accepted=False, reason="invalid", validation_errors=result.errors
                )
        self._validation_errors = []
        self._reviews[data.step] = data
        return ReviewOutcome(accepted=True, decision=data.decision)

    @workflows.workflow.signal(name="cancel_requested")
    async def cancel_requested(self) -> None:
        self._cancel_requested = True

    @workflows.workflow.query(name="review_state")
    def review_state(self) -> DocumentReviewState:
        return DocumentReviewState(
            status=self._status,
            current_review_step=self._current_review_step,
            extracted=self._extracted,
            ocr=self._ocr,
            extraction_schema=self._extraction_schema,
            schema_name=self._schema_name,
            prompt=self._prompt,
            validation_errors=self._validation_errors,
            document_key=self._document_key,
            file_name=self._file_name,
            mime_type=self._mime_type,
            review_decision=self._review_decision,
        )

    @workflows.workflow.entrypoint
    async def run(
        self, request: DocumentExtractionRequest
    ) -> DocumentExtractionResponse:
        try:
            return await self._run(request)
        except Exception:
            self._status = WorkflowRunStatus.FAILED
            self._current_review_step = None
            raise

    async def _run(
        self, request: DocumentExtractionRequest
    ) -> DocumentExtractionResponse:
        if not request.document_key:
            raise ValueError("Provide a document_key from the upload route")

        document_type = resolve_document_type(request.schema_name)
        self._schema_name = request.schema_name
        self._extraction_schema = document_type.model_json_schema()
        self._prompt = request.prompt or default_workflow().default_prompt

        # The review screen can open while OCR is still running.
        self._document_key = request.document_key
        self._file_name = request.file_name
        self._mime_type = request.mime_type

        self._status = WorkflowRunStatus.RUNNING
        self._ocr = await activities.document_annotation_ui_document_ocr(
            document_key=request.document_key,
            file_name=request.file_name,
            mime_type=request.mime_type,
        )

        if self._cancel_requested:
            return self._cancelled_response()

        self._extracted = await activities.document_annotation_ui_document_extract(
            pages=self._ocr.pages,
            schema_name=request.schema_name,
            prompt=self._prompt,
            expected_schema=self._extraction_schema,
        )

        if self._cancel_requested:
            return self._cancelled_response()

        step = default_workflow().review_step
        if step is None:
            self._status = WorkflowRunStatus.COMPLETED
            return DocumentExtractionResponse(
                status=WorkflowRunStatus.COMPLETED, extracted=self._extracted
            )

        self._status = WorkflowRunStatus.PENDING_REVIEW
        self._current_review_step = step

        await workflows.workflow.wait_condition(
            lambda: step in self._reviews or self._cancel_requested
        )
        if self._cancel_requested:
            return self._cancelled_response()

        review = self._reviews[step]
        self._current_review_step = None
        self._review_decision = review.decision

        if review.decision == ReviewDecision.REJECTED:
            self._status = WorkflowRunStatus.REJECTED
            self._extracted = None
            return DocumentExtractionResponse(
                status=WorkflowRunStatus.REJECTED,
                decision=review.decision,
                extracted=None,
            )

        candidate = (
            ExtractedDocument.model_validate(review.reviewed_output)
            if review.reviewed_output is not None
            else self._extracted
        )
        # Normalize once more before persisting the reviewed output.
        checked = self._validate_data(candidate.data)
        if checked.errors:
            self._validation_errors = checked.errors
            raise ValueError("Approved result did not conform to the schema")
        final = candidate.model_copy(update={"data": checked.data})
        self._validation_errors = []
        self._extracted = final
        self._status = WorkflowRunStatus.COMPLETED
        return DocumentExtractionResponse(
            status=WorkflowRunStatus.COMPLETED,
            decision=review.decision,
            extracted=final,
        )

    def _cancelled_response(self) -> DocumentExtractionResponse:
        self._status = WorkflowRunStatus.CANCELLED
        self._current_review_step = None
        return DocumentExtractionResponse(status=WorkflowRunStatus.CANCELLED)
