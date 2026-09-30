"""Workflow metadata for the Document Annotation UI capability.

The core WorkflowRouter routes a workflow class but carries no UI metadata and does not enumerate a
capability's workflows. This catalog is the single source for those stable facts, so adding a
workflow or flipping show_debug is a one-line edit here.
"""

from pydantic import BaseModel, ConfigDict

from mistralai_capabilities.document_annotation_ui.prompts import DEFAULT_EXTRACTION_PROMPT


class DocumentAnnotationUiWorkflow(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    display_name: str
    description: str
    review_step: str | None
    show_debug: bool
    route_segment: str
    default_prompt: str = DEFAULT_EXTRACTION_PROMPT


DOCUMENT_ANNOTATION_UI_WORKFLOWS: tuple[DocumentAnnotationUiWorkflow, ...] = (
    DocumentAnnotationUiWorkflow(
        name="document_annotation_ui_document_extraction",
        display_name="Document Extraction",
        description="Extracts structured data from uploaded documents with OCR, LLM extraction, and human review.",
        review_step="extraction_review",
        show_debug=True,
        route_segment="document",
        default_prompt=DEFAULT_EXTRACTION_PROMPT,
    ),
)

# The catalog's workflow names, for the ownership guard shared by the Document Annotation UI execution-id routes.
CATALOG_NAMES: tuple[str, ...] = tuple(workflow.name for workflow in DOCUMENT_ANNOTATION_UI_WORKFLOWS)


def get_workflow(name: str) -> DocumentAnnotationUiWorkflow | None:
    return next((workflow for workflow in DOCUMENT_ANNOTATION_UI_WORKFLOWS if workflow.name == name), None)


def default_workflow() -> DocumentAnnotationUiWorkflow:
    return DOCUMENT_ANNOTATION_UI_WORKFLOWS[0]
