import structlog
from fastapi import APIRouter, HTTPException
from mistralai_capabilities.document_annotation_ui.api import (
    ExecutionRoute,
    RequireOwned,
    load_review_state,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    DocumentReviewState,
    ExtractedDocument,
    ReviewDecision,
    ReviewOutcome,
    ReviewSignal,
    WorkflowRunStatus,
)
from mistralai_capabilities.fastapi_auth.identity import CurrentUser
from mistralai_capabilities.fastapi_workflows_auth.commands import Commands
from mistralai_capabilities.fastapi_workflows_auth.ownership import Executions
from pydantic import BaseModel

_NOT_AWAITING = "This run is not awaiting review"
_ALREADY_REVIEWED = "This run has already been reviewed"
logger = structlog.get_logger(__name__)

router = APIRouter(route_class=ExecutionRoute)


class DocumentReviewSubmission(BaseModel):
    decision: ReviewDecision
    step: str | None = None
    reviewed_output: ExtractedDocument | None = None
    note: str | None = None


class ReviewAccepted(BaseModel):
    message: str | None = None


@router.get(
    "/executions/{execution_id}/review-state",
    operation_id="document_annotation_ui_document_extraction_review_state",
    dependencies=[RequireOwned],
)
async def get_review_state(
    execution_id: str,
    commands: Commands,
    user: CurrentUser,
    executions: Executions,
) -> DocumentReviewState:
    state = await load_review_state(commands, execution_id)
    # The decision comes from the workflow now — the authority. If the run is decided but the
    # denormalized store row is missing the outcome (a persist that failed after the update), heal it
    # so the list agrees. Best-effort and idempotent; a failure just retries on the next poll.
    if state.review_decision is not None:
        try:
            await executions.set_outcome(
                execution_id=execution_id, user_id=user.user_id, outcome=state.review_decision.value
            )
        except Exception:
            logger.warning("document_annotation_ui_review_outcome_repair_failed", execution_id=execution_id)
    return state


@router.post(
    "/executions/{execution_id}/review",
    operation_id="document_annotation_ui_document_extraction_submit_review",
    status_code=202,
    dependencies=[RequireOwned],
)
async def submit_review(
    execution_id: str,
    body: DocumentReviewSubmission,
    commands: Commands,
    user: CurrentUser,
    executions: Executions,
) -> ReviewAccepted:
    # Fast-path: a run already decided (e.g. reopened in another tab) is refused before we touch the
    # run. The update below is the real authority; this only saves a round-trip on the common path
    # and gives the clearer 409.
    already_decided = (await executions.outcomes(execution_ids=[execution_id], user_id=user.user_id)).get(execution_id)
    if already_decided is not None:
        raise HTTPException(status_code=409, detail=_ALREADY_REVIEWED)
    # Signals are consumed by membership test, so one sent before the gate opens would be applied
    # the instant it is first evaluated — pre-supplying a result. Refuse unless the run is actually
    # awaiting a step right now.
    state = await load_review_state(commands, execution_id)
    target_step = state.current_review_step
    if state.status != WorkflowRunStatus.PENDING_REVIEW or target_step is None:
        raise HTTPException(status_code=409, detail=_NOT_AWAITING)
    # An explicit step must name the one the run is on: a client targeting a different step is
    # refused rather than silently redirected to the awaited one.
    if body.step is not None and body.step != target_step:
        raise HTTPException(status_code=409, detail=_NOT_AWAITING)

    reviewed_output = body.reviewed_output.model_dump(mode="json", by_alias=True) if body.reviewed_output else None
    signal = ReviewSignal(
        step=target_step,
        decision=body.decision,
        reviewed_output=reviewed_output,
        note=body.note,
        reviewed_by=user.user_id,
    )
    # Deliver as a synchronous, deduplicated UPDATE, not a fire-and-forget signal: it returns the
    # decision the run is now bound to (first writer wins inside the workflow), so we persist exactly
    # what the workflow accepted — the badge cannot diverge from the run outcome, and a failed update
    # persists nothing and is safely retryable (no decided-but-paused wedge).
    response = await commands.update_execution(
        execution_id,
        name="review_result",
        input=signal.model_dump(mode="json"),
    )
    outcome = ReviewOutcome.model_validate(response.result)
    if not outcome.accepted:
        # The workflow is the single validation authority. It rejects an approved edit that violates
        # the schema with reason="invalid" — surface that as a 422 with the field errors so the
        # client can fix them. Any other refusal means the run left the gate between our pre-check
        # and the update (a rare race).
        if outcome.reason == "invalid":
            raise HTTPException(status_code=422, detail=[error.model_dump() for error in outcome.validation_errors])
        raise HTTPException(status_code=409, detail=_NOT_AWAITING)
    if outcome.decision is None:
        raise HTTPException(status_code=409, detail=_NOT_AWAITING)
    # Denormalize the confirmed decision as the run's outcome for the list badge. Best-effort: the
    # workflow already holds it (get_review_state re-reads and re-persists it), so a failed write here
    # is healed on the next poll rather than 500-ing a review the run already accepted.
    try:
        await executions.set_outcome(execution_id=execution_id, user_id=user.user_id, outcome=outcome.decision.value)
    except Exception:
        logger.warning("document_annotation_ui_review_outcome_persist_failed", execution_id=execution_id)
    return ReviewAccepted()
