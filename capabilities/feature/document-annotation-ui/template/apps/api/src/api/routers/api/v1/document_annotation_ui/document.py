from mistralai_capabilities.document_annotation_ui.schemas import (
    DocumentExtractionRequest,
)
from mistralai_capabilities.document_annotation_ui.storage import (
    is_owned_document,
)
from mistralai_capabilities.fastapi_workflows_auth.router import ALL_OPERATIONS, WorkflowRouter
from worker.workflows.document_annotation_ui import DocumentExtractionWorkflow

# The workflow declares an update (`review_result`) and a signal (`cancel_requested`), so the router
# would otherwise auto-mount the generic `POST /executions/{id}/updates` and `/signals` routes. Those
# take `{name, input}`, so an owner could call `review_result` directly, forging `reviewed_by` and
# skipping `submit_review`'s server-side binding. Mount only the typed `submit_review` route; nothing
# sends `cancel_requested`, so dropping the signal route costs nothing.
_GENERIC_COMMAND_ROUTES = frozenset({"execution_signal", "execution_update"})


async def _owns_document(*, execution_id: str, body: DocumentExtractionRequest, user_id: str) -> bool:
    """Refuse a run whose document_key was not minted for this caller (returning False -> 404).

    Validating the key here, after the ownership row is written and before the workflow starts,
    is what lets the workflow and OCR activity trust it without threading user_id into Temporal.
    """
    return body.document_key is None or is_owned_document(body.document_key, user_id)


router = WorkflowRouter(
    DocumentExtractionWorkflow,
    name="document_annotation_ui_document_extraction",
    operations=ALL_OPERATIONS - _GENERIC_COMMAND_ROUTES,
    on_create=_owns_document,
)
