from fastapi import APIRouter
from mistralai_capabilities.document_annotation_ui.workflows_catalog import (
    DOCUMENT_ANNOTATION_UI_WORKFLOWS,
)
from pydantic import BaseModel

router = APIRouter()


class DocumentAnnotationUiWorkflowInfo(BaseModel):
    name: str
    display_name: str
    description: str
    review_step: str | None
    show_debug: bool
    route_segment: str


@router.get(
    "",
    operation_id="document_annotation_ui_list_workflows",
)
async def list_workflows() -> list[DocumentAnnotationUiWorkflowInfo]:
    return [
        DocumentAnnotationUiWorkflowInfo(
            name=workflow.name,
            display_name=workflow.display_name,
            description=workflow.description,
            review_step=workflow.review_step,
            show_debug=workflow.show_debug,
            route_segment=workflow.route_segment,
        )
        for workflow in DOCUMENT_ANNOTATION_UI_WORKFLOWS
    ]
