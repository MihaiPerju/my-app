"""API-layer wiring the Document Annotation UI hand-rolled routers share.

The hand-rolled routers in ``review.py`` and ``reviews.py`` need two things the generated
``WorkflowRouter`` routes get free: ``ExecutionRoute`` (it maps a platform 404 for a withdrawn
execution to the canonical ``Unknown execution`` 404) and a catalog-scoped ownership guard.

It lives in this toolkit rather than in ``apps/api`` because it is this capability's code, the
same way chat keeps its own collaborators under ``mistralai_capabilities.chat.vibe``. It
is the one module here that imports FastAPI, so it stays out of ``__init__`` — the worker imports
every ``studio`` feature package and must never reach a web framework through one.
"""

from fastapi import Depends, HTTPException
from mistralai_capabilities.fastapi_workflows_auth.commands import ExecutionCommands
from mistralai_capabilities.fastapi_workflows_auth.ownership import require_owned_any
from mistralai_capabilities.fastapi_workflows_auth.router import ExecutionRoute
from mistralai_capabilities.document_annotation_ui.schemas import DocumentReviewState
from mistralai_capabilities.document_annotation_ui.storage import is_owned_document
from mistralai_capabilities.document_annotation_ui.workflows_catalog import CATALOG_NAMES

__all__ = ["ExecutionRoute", "RequireOwned", "load_review_state", "owned_document_key"]

RequireOwned = Depends(require_owned_any(CATALOG_NAMES))


async def load_review_state(commands: ExecutionCommands, execution_id: str) -> DocumentReviewState:
    """The run's ``review_state``, as the query the hand-rolled routers all read it through.

    The literal query name lives here alone: every Document Annotation UI route that needs
    the run's own view of its document and decision goes through this, so the workflow's query
    contract has one caller to keep in step rather than four.
    """
    response = await commands.query_execution(execution_id, name="review_state", input=None)
    return DocumentReviewState.model_validate(response.result)


def owned_document_key(state: DocumentReviewState, user_id: str) -> str:
    """The run's stored-document key once confirmed to be this caller's, or the canonical 404.

    The key is re-checked with ``is_owned_document`` because a legacy run can carry a key its caller
    never uploaded; a run with no key or someone else's key is indistinguishable from no run, so both
    collapse to the same 404 rather than leaking which.
    """
    if not state.document_key or not is_owned_document(state.document_key, user_id):
        raise HTTPException(status_code=404, detail="This run holds no stored document")
    return state.document_key
