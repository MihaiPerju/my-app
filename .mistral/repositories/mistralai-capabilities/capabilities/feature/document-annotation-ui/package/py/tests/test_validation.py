from collections.abc import Iterator

import pytest
from mistralai_capabilities.document_annotation_ui.document_types import (
    DOCUMENT_TYPES,
    DocumentType,
    Example,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    SchemaFieldError,
)
from mistralai_capabilities.document_annotation_ui.validation import (
    DocumentTypeChangedError,
    ValidationResult,
    resolve_document_type,
    resolve_document_type_for_schema,
    validate_document_type,
)
from pydantic import Field


class _Coercing(DocumentType):
    title: str
    amount: float | None = None


class _LineItem(DocumentType):
    quantity: int


class _Nested(DocumentType):
    line_items: list[_LineItem]


class _Aliased(DocumentType):
    invoice_number: str = Field(alias="invoiceNumber")


@pytest.fixture
def registered_document_types() -> Iterator[None]:
    DOCUMENT_TYPES["_coercing"] = _Coercing
    DOCUMENT_TYPES["_nested"] = _Nested
    DOCUMENT_TYPES["_aliased"] = _Aliased
    try:
        yield
    finally:
        DOCUMENT_TYPES.pop("_coercing", None)
        DOCUMENT_TYPES.pop("_nested", None)
        DOCUMENT_TYPES.pop("_aliased", None)


def test_resolve_document_type_returns_the_registered_model() -> None:
    assert resolve_document_type("example") is Example


def test_resolve_document_type_rejects_an_unknown_name() -> None:
    with pytest.raises(ValueError, match="Unknown document type"):
        resolve_document_type("nope")


def test_resolve_document_type_rejects_schema_drift(
    registered_document_types: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Changed(DocumentType):
        title: str
        reference: str

    expected_schema = _Coercing.model_json_schema()
    monkeypatch.setitem(DOCUMENT_TYPES, "_coercing", Changed)

    with pytest.raises(DocumentTypeChangedError, match="changed after this workflow started"):
        resolve_document_type_for_schema("_coercing", expected_schema)


def test_resolve_document_type_treats_a_removed_snapshot_as_schema_drift() -> None:
    with pytest.raises(DocumentTypeChangedError, match="was removed after this workflow started"):
        resolve_document_type_for_schema("removed", Example.model_json_schema())


def test_validate_document_type_coerces_and_persists(
    registered_document_types: None,
) -> None:
    result = validate_document_type(
        "_coercing",
        {"title": "Acme", "amount": "120"},
        expected_schema=_Coercing.model_json_schema(),
    )

    assert result.errors == []
    assert result.data["amount"] == 120.0
    assert isinstance(result.data["amount"], float)


def test_validate_document_type_reports_field_error(
    registered_document_types: None,
) -> None:
    result = validate_document_type(
        "_coercing",
        {"title": "Acme", "amount": "not a number"},
        expected_schema=_Coercing.model_json_schema(),
    )

    assert len(result.errors) == 1
    assert result.errors[0].path == "amount"
    assert isinstance(result.errors[0], SchemaFieldError)


def test_validate_document_type_reports_a_missing_required_field() -> None:
    result = validate_document_type(
        "example",
        {},
        expected_schema=Example.model_json_schema(),
    )

    assert [error.path for error in result.errors] == ["title"]


def test_validation_paths_use_dot_notation(registered_document_types: None) -> None:
    result = validate_document_type(
        "_nested",
        {"line_items": [{"quantity": "not a number"}]},
        expected_schema=_Nested.model_json_schema(),
    )

    assert [error.path for error in result.errors] == ["line_items.0.quantity"]


def test_validate_document_type_preserves_schema_aliases(
    registered_document_types: None,
) -> None:
    result = validate_document_type(
        "_aliased",
        {"invoiceNumber": "INV-42"},
        expected_schema=_Aliased.model_json_schema(),
    )

    assert result.errors == []
    assert result.data == {"invoiceNumber": "INV-42"}


def test_validation_result_shape() -> None:
    result = ValidationResult(errors=[], data={"x": 1})

    assert result.errors == []
    assert result.data == {"x": 1}
