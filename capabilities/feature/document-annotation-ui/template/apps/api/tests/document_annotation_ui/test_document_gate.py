import pytest
from api.routers.api.v1.document_annotation_ui import document
from mistralai_capabilities.document_annotation_ui.schemas import (
    DocumentExtractionRequest,
)


@pytest.mark.asyncio
async def test_create_gate_checks_document_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(document, "is_owned_document", lambda _key, _user: True)
    body = DocumentExtractionRequest(document_key="k", schema_name="example")

    assert await document._owns_document(execution_id="e", body=body, user_id="u") is True


def test_mount_hides_the_generic_signal_and_update_routes() -> None:
    # The generic {name,input} signal/update routes would let an owner call review_result directly,
    # forging reviewed_by and skipping submit_review. Only typed routes may reach the workflow.
    paths = {route.path for route in document.router.routes}

    assert not any(path.endswith("/signals") for path in paths), paths
    assert not any(path.endswith("/updates") for path in paths), paths


def test_run_start_body_coerces_a_hostile_mime_type_before_it_reaches_ocr() -> None:
    # A run can be started directly with this body, never touching the upload route, and mime_type is
    # what the OCR activity puts into its data:{mime};base64,... URL. A comma would truncate the URL,
    # so the request must normalize it to the octet-stream fallback at its own boundary.
    body = DocumentExtractionRequest(document_key="k", schema_name="example", mime_type="text/plain,garbage")

    assert body.mime_type == "application/octet-stream"
