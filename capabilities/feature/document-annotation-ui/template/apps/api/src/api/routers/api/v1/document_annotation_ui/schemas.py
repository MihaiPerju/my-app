from typing import Any

from fastapi import APIRouter
from mistralai_capabilities.document_annotation_ui.document_types import DOCUMENT_TYPES
from mistralai_capabilities.document_annotation_ui.workflows_catalog import default_workflow
from pydantic import BaseModel

router = APIRouter()


class DocumentTypeInfo(BaseModel):
    name: str
    display_name: str
    # The resolved JSON Schema the run will extract against, so the form can show it read-only the
    # moment a type is picked — without a prior run or a per-type schema route. It is the same shape
    # the worker derives from the pydantic model (`model_json_schema()`).
    json_schema: dict[str, Any]


class DocumentAnnotationUiSchemasResponse(BaseModel):
    document_types: list[DocumentTypeInfo]
    default_prompt: str


@router.get(
    "",
    operation_id="document_annotation_ui_list_schemas",
)
async def list_schemas() -> DocumentAnnotationUiSchemasResponse:
    return DocumentAnnotationUiSchemasResponse(
        document_types=[
            DocumentTypeInfo(name=name, display_name=model.__name__, json_schema=model.model_json_schema())
            for name, model in DOCUMENT_TYPES.items()
        ],
        default_prompt=default_workflow().default_prompt,
    )
