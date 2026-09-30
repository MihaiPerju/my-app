from types import SimpleNamespace
from typing import Any, cast

import pytest
from mistralai_capabilities.document_annotation_ui import activities
from mistralai_capabilities.document_annotation_ui.document_types import (
    DOCUMENT_TYPES,
    DocumentType,
    Example,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    OcrBlockResult,
    OcrPageResult,
)
from mistralai_capabilities.document_annotation_ui.storage import (
    DocumentNotFoundError,
)
from mistralai_capabilities.document_annotation_ui.validation import (
    DocumentTypeChangedError,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class SampleDocument(DocumentType):
    title: str
    amount: float


class StrictBand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: float


class StrictSchedule(BaseModel):
    bands: list[StrictBand]


class StrictDocument(DocumentType):
    storage_schedules: list[StrictSchedule]


class AliasedDocument(DocumentType):
    invoice_number: str = Field(alias="invoiceNumber")


@pytest.fixture(autouse=True)
def registered_test_document_types(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(DOCUMENT_TYPES, "sample_document", SampleDocument)
    monkeypatch.setitem(DOCUMENT_TYPES, "strict_document", StrictDocument)
    monkeypatch.setitem(DOCUMENT_TYPES, "aliased_document", AliasedDocument)


# base64 of b"fake-pdf", the bytes the storage double serves.
DOCUMENT_BASE64 = "ZmFrZS1wZGY="
DOCUMENT_BYTES = b"fake-pdf"

# __original_func__ bypasses the workflow DI decorator on the OCR activity.
_ocr = cast(Any, activities.document_annotation_ui_document_ocr).__original_func__


def _typed_ocr_response() -> SimpleNamespace:
    block = SimpleNamespace(
        content="Total 120.00",
        type="text",
        top_left_x=10,
        top_left_y=20,
        bottom_right_x=30,
        bottom_right_y=40,
    )
    page = SimpleNamespace(
        index=0,
        markdown="# Statement\n\nTotal 120.00",
        images=[SimpleNamespace(id="img-1", image_base64="data:image/png;base64,aW1n")],
        confidence_scores=SimpleNamespace(average_page_confidence_score=0.98),
        dimensions=SimpleNamespace(width=800, height=1000),
        blocks=[block],
    )
    return SimpleNamespace(pages=[page])


class _FakeOcr:
    def __init__(self, calls: list[dict[str, Any]]) -> None:
        self._calls = calls

    async def process_async(self, **kwargs: Any) -> SimpleNamespace:
        self._calls.append(kwargs)
        return _typed_ocr_response()


def _fake_client(calls: list[dict[str, Any]]) -> SimpleNamespace:
    return SimpleNamespace(ocr=_FakeOcr(calls))


@pytest.fixture
def stored_images(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[str, list[tuple[str, bytes, str | None]]]]:
    """Capture OCR image uploads instead of hitting a real object-storage backend."""
    captured: list[tuple[str, list[tuple[str, bytes, str | None]]]] = []

    async def fake_put(document_key: str, images: object) -> None:
        captured.append((document_key, list(images)))  # type: ignore[arg-type]

    monkeypatch.setattr(activities, "put_document_images", fake_put)
    return captured


EXPECTED_OCR_CALL = {
    "model": "mistral-ocr-4-0",
    "document": {
        "type": "document_url",
        "document_url": f"data:application/pdf;base64,{DOCUMENT_BASE64}",
    },
    "include_image_base64": True,
    "include_blocks": True,
}


@pytest.mark.asyncio
async def test_document_annotation_ui_document_ocr_reads_the_document_from_storage_and_calls_the_sdk(
    monkeypatch: pytest.MonkeyPatch,
    stored_images: list[tuple[str, list[tuple[str, bytes, str | None]]]],
) -> None:
    calls: list[dict[str, Any]] = []
    fetched: list[str] = []

    async def fake_get_document(key: str) -> bytes:
        fetched.append(key)
        return DOCUMENT_BYTES

    monkeypatch.setattr(activities, "get_document", fake_get_document)
    monkeypatch.setattr(activities, "get_mistral_client", lambda: _fake_client(calls))

    result = await _ocr(
        document_key="document_annotation_ui/documents/2f1c/document.pdf",
        file_name="document.pdf",
        mime_type="application/pdf",
    )

    assert fetched == ["document_annotation_ui/documents/2f1c/document.pdf"]
    assert calls[0] == EXPECTED_OCR_CALL
    assert result.ocr_text == "# Statement\n\nTotal 120.00"
    assert result.pages[0].blocks[0].content == "Total 120.00"


@pytest.mark.asyncio
async def test_document_annotation_ui_document_ocr_propagates_a_missing_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_get_document(key: str) -> bytes:
        raise DocumentNotFoundError(f"No document stored at {key!r}")

    monkeypatch.setattr(activities, "get_document", fake_get_document)
    monkeypatch.setattr(activities, "get_mistral_client", lambda: _fake_client([]))

    with pytest.raises(
        DocumentNotFoundError,
        match=r"document_annotation_ui/documents/gone/document\.pdf",
    ):
        await _ocr(
            document_key="document_annotation_ui/documents/gone/document.pdf",
        )


@pytest.mark.asyncio
async def test_document_annotation_ui_document_ocr_maps_the_typed_response_from_the_data_url(
    monkeypatch: pytest.MonkeyPatch,
    stored_images: list[tuple[str, list[tuple[str, bytes, str | None]]]],
) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_get_document(_key: str) -> bytes:
        return DOCUMENT_BYTES

    monkeypatch.setattr(activities, "get_document", fake_get_document)
    monkeypatch.setattr(activities, "get_mistral_client", lambda: _fake_client(calls))

    result = await _ocr(
        document_key="document_annotation_ui/documents/2f1c/document.pdf",
        file_name="document.pdf",
        mime_type="application/pdf",
    )

    assert calls[0] == EXPECTED_OCR_CALL
    assert result.ocr_text == "# Statement\n\nTotal 120.00"
    assert result.page_count == 1
    assert result.page_confidences == [0.98]
    assert result.pages[0].image_ids == ["img-1"]
    # The image bytes are pushed to object storage, not returned in the workflow result.
    assert stored_images == [
        (
            "document_annotation_ui/documents/2f1c/document.pdf",
            [("img-1", b"img", "image/png")],
        )
    ]
    assert not hasattr(result, "images")
    assert result.pages[0].blocks[0].content == "Total 120.00"


@pytest.mark.asyncio
async def test_document_annotation_ui_document_ocr_requires_a_document_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(activities, "get_mistral_client", lambda: _fake_client([]))
    with pytest.raises(ValueError, match="document_key"):
        await _ocr()


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_formats_sources_and_returns_schema_driven_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[type[Any], Any]] = []

    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        calls.append((response_format, request))
        return response_format.model_validate(
            {
                "data": {"title": "Acme", "amount": 120.0},
                "_sources": [{"path": "title", "source_ids": ["source_0"]}],
            }
        )

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    page = OcrPageResult(
        index=7,
        width=800,
        height=1000,
        blocks=[
            OcrBlockResult(
                content="Acme Corp",
                type="text",
                top_left_x=1,
                top_left_y=2,
                bottom_right_x=3,
                bottom_right_y=4,
            )
        ],
    )

    document = await activities.document_annotation_ui_document_extract(
        pages=[page],
        schema_name="sample_document",
        prompt="Look for the supplier name",
        expected_schema=SampleDocument.model_json_schema(),
    )

    assert calls[0][1].model == "zai-glm-5-2"
    assert calls[0][1].reasoning_effort == "xhigh"
    assert calls[0][1].temperature == 0.0
    assert calls[0][1].top_p == 1.0
    assert calls[0][1].random_seed == 42
    response_schema = calls[0][0].model_json_schema()
    assert list(response_schema["$defs"]["SampleDocument"]["properties"]) == [
        "title",
        "amount",
    ]
    assert calls[0][1].messages[1].content == "OCR source blocks:\n[source_0] (page 7, text) Acme Corp"
    assert calls[0][1].messages[0].content == "Look for the supplier name"
    assert document.data == {"title": "Acme", "amount": 120.0}
    assert document.sources == {"title": ["source_0"]}


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_rejects_schema_drift_before_calling_mistral(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ChangedDocument(DocumentType):
        title: str
        reference: str

    async def fail_chat_parse(response_format: type[Any], request: Any) -> Any:
        raise AssertionError("Mistral must not be called after schema drift")

    expected_schema = SampleDocument.model_json_schema()
    monkeypatch.setitem(DOCUMENT_TYPES, "sample_document", ChangedDocument)
    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fail_chat_parse)

    with pytest.raises(DocumentTypeChangedError, match="changed after this workflow started"):
        await activities.document_annotation_ui_document_extract(
            pages=[],
            schema_name="sample_document",
            prompt="p",
            expected_schema=expected_schema,
        )


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_sends_the_prompt_verbatim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[type[Any], Any]] = []

    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        calls.append((response_format, request))
        return response_format.model_validate({"data": {"title": "Acme"}, "_sources": []})

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="example",
        prompt="custom prompt",
        expected_schema=Example.model_json_schema(),
    )

    assert calls[0][1].messages[0].content == "custom prompt"


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_honors_configured_model_and_omits_disabled_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[type[Any], Any]] = []

    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        calls.append((response_format, request))
        return response_format.model_validate({"data": {"title": "Acme"}, "_sources": []})

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    monkeypatch.setattr(
        activities.document_annotation_ui_env,
        "document_annotation_ui_extract_model",
        "custom-extract-model",
    )
    monkeypatch.setattr(
        activities.document_annotation_ui_env,
        "document_annotation_ui_extract_reasoning_effort",
        "none",
    )

    await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="example",
        prompt="p",
        expected_schema=Example.model_json_schema(),
    )

    assert calls[0][1].model == "custom-extract-model"
    re = getattr(calls[0][1], "reasoning_effort", None)
    assert re is None or type(re).__name__ == "Unset"


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_model_path_uses_pydantic_structured_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[type[Any], Any]] = []

    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        calls.append((response_format, request))
        return response_format.model_validate(
            {
                "data": {"title": "Acme"},
                "_sources": [{"path": "title", "source_ids": ["source_0"]}],
            }
        )

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    document = await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="example",
        prompt="p",
        expected_schema=Example.model_json_schema(),
    )

    assert document.data == {"title": "Acme"}
    assert document.sources == {"title": ["source_0"]}
    assert calls[0][0].__name__ == "DocumentExtractionStructuredOutput"


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_preserves_schema_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        return response_format.model_validate(
            {
                "data": {"invoiceNumber": "INV-42"},
                "_sources": [{"path": "invoiceNumber", "source_ids": ["source_0"]}],
            }
        )

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    document = await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="aliased_document",
        prompt="p",
        expected_schema=AliasedDocument.model_json_schema(),
    )

    assert document.data == {"invoiceNumber": "INV-42"}
    assert document.sources == {"invoiceNumber": ["source_0"]}


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_rejects_model_extras_before_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        return response_format.model_validate(
            {
                "data": {"storage_schedules": [{"bands": [{"value": 10, "unit": "per day"}]}]},
                "_sources": [],
            }
        )

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    with pytest.raises(ValidationError, match=r"storage_schedules\.0\.bands\.0\.unit"):
        await activities.document_annotation_ui_document_extract(
            pages=[],
            schema_name="strict_document",
            prompt="p",
            expected_schema=StrictDocument.model_json_schema(),
        )


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_keeps_nested_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response_schemas: list[dict[str, Any]] = []

    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        response_schemas.append(response_format.model_json_schema())
        return response_format.model_validate(
            {
                "data": {"storage_schedules": [{"bands": [{"value": 10}]}]},
                "_sources": [
                    {
                        "path": "storage_schedules.0.bands.0.value",
                        "source_ids": ["source_2"],
                    },
                    {
                        "path": "storage_schedules.0.bands.0.value",
                        "source_ids": ["source_3", "source_2"],
                    },
                ],
            }
        )

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    document = await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="strict_document",
        prompt="p",
        expected_schema=StrictDocument.model_json_schema(),
    )

    assert response_schemas[0]["properties"]["data"] == {"$ref": "#/$defs/StrictDocument"}
    assert document.sources == {"storage_schedules.0.bands.0.value": ["source_2", "source_3"]}


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_prunes_keys_outside_the_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        return response_format.model_validate(
            {
                "data": {"title": "Acme", "amount": 120.0, "hallucinated": "x"},
                "_sources": [
                    {"path": "title", "source_ids": ["source_0"]},
                    {"path": "hallucinated", "source_ids": ["source_1"]},
                ],
            }
        )

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    document = await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="sample_document",
        prompt="p",
        expected_schema=SampleDocument.model_json_schema(),
    )

    # "hallucinated" is not in the schema's properties, so it is dropped from data AND sources.
    assert document.data == {"title": "Acme", "amount": 120.0}
    assert document.sources == {"title": ["source_0"]}


@pytest.mark.asyncio
async def test_document_annotation_ui_document_extract_passes_configured_sampling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every sampling param is read from env, so an override reaches the SDK call verbatim."""

    calls: list[tuple[type[Any], Any]] = []

    async def fake_chat_parse(response_format: type[Any], request: Any) -> Any:
        calls.append((response_format, request))
        return response_format.model_validate({"data": {"title": "Acme"}, "_sources": []})

    monkeypatch.setattr(activities.lechat, "chat_parse_to_model", fake_chat_parse)

    monkeypatch.setattr(
        activities.document_annotation_ui_env,
        "document_annotation_ui_extract_temperature",
        0.7,
    )
    monkeypatch.setattr(
        activities.document_annotation_ui_env,
        "document_annotation_ui_extract_top_p",
        0.9,
    )
    monkeypatch.setattr(
        activities.document_annotation_ui_env,
        "document_annotation_ui_extract_random_seed",
        7,
    )

    await activities.document_annotation_ui_document_extract(
        pages=[],
        schema_name="example",
        prompt="p",
        expected_schema=Example.model_json_schema(),
    )

    assert calls[0][1].temperature == 0.7
    assert calls[0][1].top_p == 0.9
    assert calls[0][1].random_seed == 7
