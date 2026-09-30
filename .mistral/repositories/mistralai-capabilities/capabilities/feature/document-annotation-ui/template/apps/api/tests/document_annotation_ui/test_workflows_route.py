import importlib

import pytest
from fastapi.testclient import TestClient
from mistralai_capabilities.document_annotation_ui.workflows_catalog import (
    DOCUMENT_ANNOTATION_UI_WORKFLOWS,
)

from .support import auth, build_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(build_app())


def test_document_annotation_ui_workflows_lists_the_catalog(client: TestClient) -> None:
    response = client.get("/api/v1/document_annotation_ui/workflows", headers=auth())

    assert response.status_code == 200
    workflows = response.json()
    assert len(workflows) == len(DOCUMENT_ANNOTATION_UI_WORKFLOWS)
    assert workflows[0] == {
        "name": "document_annotation_ui_document_extraction",
        "display_name": "Document Extraction",
        "description": DOCUMENT_ANNOTATION_UI_WORKFLOWS[0].description,
        "review_step": "extraction_review",
        "show_debug": True,
        "route_segment": "document",
    }


def test_document_annotation_ui_workflows_operation_id_is_stable(client: TestClient) -> None:
    operation = client.app.openapi()["paths"]["/api/v1/document_annotation_ui/workflows"]["get"]

    assert operation["operationId"] == "document_annotation_ui_list_workflows"


def test_workflows_route_module_does_not_shadow_worker_workflows_package() -> None:
    local_route = importlib.import_module("api.routers.api.v1.document_annotation_ui.workflows")
    top_level_workflow = importlib.import_module("worker.workflows.document_annotation_ui")

    assert local_route.router is not None
    assert top_level_workflow.DocumentExtractionWorkflow is not None
