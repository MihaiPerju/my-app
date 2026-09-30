from dataclasses import dataclass
from typing import Any

from mistralai_capabilities.document_annotation_ui.document_types import (
    DocumentType,
    get_document_type,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    SchemaFieldError,
)
from pydantic import ValidationError

__all__ = [
    "DocumentTypeChangedError",
    "ValidationResult",
    "resolve_document_type",
    "resolve_document_type_for_schema",
    "validate_document_type",
]


class DocumentTypeChangedError(ValueError):
    """The registered model no longer matches the schema captured by a workflow run."""


@dataclass(frozen=True)
class ValidationResult:
    errors: list[SchemaFieldError]
    data: dict[str, Any]


def resolve_document_type(schema_name: str) -> type[DocumentType]:
    model = get_document_type(schema_name)
    if model is None:
        raise ValueError(f"Unknown document type: {schema_name!r}")
    return model


def resolve_document_type_for_schema(
    schema_name: str,
    expected_schema: dict[str, Any],
) -> type[DocumentType]:
    try:
        model = resolve_document_type(schema_name)
    except ValueError as error:
        raise DocumentTypeChangedError(
            f"Document type {schema_name!r} was removed after this workflow started; start a new run"
        ) from error
    if model.model_json_schema() != expected_schema:
        raise DocumentTypeChangedError(
            f"Document type {schema_name!r} changed after this workflow started; start a new run"
        )
    return model


def validate_document_type(
    schema_name: str,
    data: dict[str, Any],
    *,
    expected_schema: dict[str, Any],
) -> ValidationResult:
    """Validate and normalize data entering from the human-review boundary."""
    document_type = resolve_document_type_for_schema(schema_name, expected_schema)
    try:
        validated = document_type.model_validate(data)
    except ValidationError as error:
        field_errors = [
            SchemaFieldError(
                path=".".join(str(part) for part in item["loc"]),
                message=item["msg"],
            )
            for item in error.errors()
        ]
        return ValidationResult(
            errors=field_errors,
            data=data,
        )
    return ValidationResult(
        errors=[],
        data=validated.model_dump(mode="json", by_alias=True),
    )
