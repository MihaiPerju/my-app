import pytest
from fastapi.testclient import TestClient
from mistralai_capabilities.document_annotation_ui.document_types import DOCUMENT_TYPES
from mistralai_capabilities.document_annotation_ui.workflows_catalog import default_workflow

from .support import auth, build_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(build_app())


def test_document_annotation_ui_schemas_lists_the_registry_and_default_prompt(client: TestClient) -> None:
    response = client.get("/api/v1/document_annotation_ui/schemas", headers=auth())

    assert response.status_code == 200
    body = response.json()
    assert body["default_prompt"] == default_workflow().default_prompt
    assert {entry["name"] for entry in body["document_types"]} == set(DOCUMENT_TYPES)

    example = next(entry for entry in body["document_types"] if entry["name"] == "example")
    assert example["display_name"] == "Example"
    # Each entry carries the resolved JSON Schema, so the form can render it read-only on selection.
    assert example["json_schema"] == DOCUMENT_TYPES["example"].model_json_schema()
    assert "title" in example["json_schema"]["properties"]


def test_document_annotation_ui_schemas_operation_id_is_stable(client: TestClient) -> None:
    operation = client.app.openapi()["paths"]["/api/v1/document_annotation_ui/schemas"]["get"]

    assert operation["operationId"] == "document_annotation_ui_list_schemas"
