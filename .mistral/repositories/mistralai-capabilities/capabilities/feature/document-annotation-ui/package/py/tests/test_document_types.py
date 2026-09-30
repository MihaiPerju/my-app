from mistralai_capabilities.document_annotation_ui.document_types import (
    DOCUMENT_TYPES,
    DocumentType,
    Example,
    get_document_type,
)


def test_get_document_type_hit():
    assert get_document_type("example") is Example


def test_get_document_type_miss():
    assert get_document_type("does_not_exist") is None


def test_every_registered_value_is_a_document_type():
    assert DOCUMENT_TYPES
    for model in DOCUMENT_TYPES.values():
        assert issubclass(model, DocumentType)


def test_extra_keys_are_dropped_not_rejected():
    parsed = Example.model_validate({"title": "Q3 report", "hallucinated": "x"})
    assert parsed.model_dump() == {"title": "Q3 report"}


def test_example_json_schema_has_non_empty_properties():
    schema = Example.model_json_schema()
    assert schema["type"] == "object"
    assert schema["properties"]
    assert "title" in schema["properties"]
