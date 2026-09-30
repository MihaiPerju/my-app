from pydantic import BaseModel, ConfigDict


class DocumentType(BaseModel):
    # extra="ignore" so a hallucinated key is dropped, not rejected: the value-level contract
    # (types/required) is what we enforce, and pruning already removes unknown top-level keys.
    model_config = ConfigDict(extra="ignore")


class Example(DocumentType):
    # A minimal, business-logic-free starter type: one required string field. Adding a real type is
    # a pydantic class here plus one DOCUMENT_TYPES entry.
    title: str


DOCUMENT_TYPES: dict[str, type[DocumentType]] = {"example": Example}


def get_document_type(name: str) -> type[DocumentType] | None:
    return DOCUMENT_TYPES.get(name)
