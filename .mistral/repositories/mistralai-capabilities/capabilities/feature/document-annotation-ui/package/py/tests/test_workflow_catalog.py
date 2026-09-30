from pydantic import ValidationError

import mistralai.workflows as workflows
import pytest

from mistralai_capabilities.document_annotation_ui.workflow import DocumentExtractionWorkflow
from mistralai_capabilities.document_annotation_ui.workflows_catalog import (
    DOCUMENT_ANNOTATION_UI_WORKFLOWS,
    DocumentAnnotationUiWorkflow,
    default_workflow,
    get_workflow,
)


DOCUMENT_EXTRACTION_DESCRIPTION = (
    "Extracts structured data from uploaded documents with OCR, LLM extraction, and human review."
)


def test_catalog_declares_the_day_one_document_extraction_workflow() -> None:
    assert isinstance(DOCUMENT_ANNOTATION_UI_WORKFLOWS, tuple)
    assert DOCUMENT_ANNOTATION_UI_WORKFLOWS == (
        DocumentAnnotationUiWorkflow(
            name="document_annotation_ui_document_extraction",
            display_name="Document Extraction",
            description=DOCUMENT_EXTRACTION_DESCRIPTION,
            review_step="extraction_review",
            show_debug=True,
            route_segment="document",
        ),
    )


def test_catalog_lookup_and_default_workflow_are_stable() -> None:
    workflow = get_workflow("document_annotation_ui_document_extraction")

    assert workflow is DOCUMENT_ANNOTATION_UI_WORKFLOWS[0]
    assert get_workflow("nope") is None
    assert default_workflow() is DOCUMENT_ANNOTATION_UI_WORKFLOWS[0]


def test_default_prompt_requires_data_relative_citation_paths() -> None:
    prompt = default_workflow().default_prompt

    assert (
        "Citation paths are relative to `data`; NEVER prefix them with `data.`."
        in prompt
    )
    assert "`line_items.0.amount`, not `data.line_items.0.amount`" in prompt


def test_workflow_metadata_is_immutable() -> None:
    workflow = DOCUMENT_ANNOTATION_UI_WORKFLOWS[0]

    with pytest.raises(ValidationError):
        workflow.display_name = "Other"


def test_catalog_is_the_source_of_the_registered_workflow_metadata() -> None:
    definition = workflows.get_workflow_definition(DocumentExtractionWorkflow)
    workflow = default_workflow()

    assert definition.name == workflow.name
    assert definition.display_name == workflow.display_name
    assert definition.description == workflow.description


def test_catalog_data_allows_future_workflows_to_disable_debug_and_skip_review() -> None:
    workflow = DocumentAnnotationUiWorkflow(
        name="future_no_review",
        display_name="Future No Review",
        description="Runs without a human review pause.",
        review_step=None,
        show_debug=False,
        route_segment="future",
    )

    assert workflow.review_step is None
    assert workflow.show_debug is False
