import base64
from datetime import timedelta

import mistralai.workflows as workflows
import mistralai.workflows.plugins.mistralai as lechat
from env.document_annotation_ui import (
    env as document_annotation_ui_env,
)
from env.workflows import env as workflows_env
from mistralai.workflows.plugins.mistralai import get_mistral_client
from mistralai_capabilities.document_annotation_ui.document_types import (
    DocumentType,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    ExtractedDocument,
    OcrBlockResult,
    OcrDocumentResult,
    OcrPageResult,
)
from mistralai_capabilities.document_annotation_ui.storage import (
    get_document,
    put_document_images,
)
from mistralai_capabilities.document_annotation_ui.validation import (
    resolve_document_type_for_schema,
)
from pydantic import BaseModel, ConfigDict, Field, create_model


class SourceCitation(BaseModel):
    """One field-to-OCR citation emitted by the structured extraction call."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)


class DocumentExtractionStructuredOutput(BaseModel):
    """Typed SDK response, specialized with the selected document model at runtime."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    data: DocumentType
    source_citations: list[SourceCitation] = Field(alias="_sources")


def _decode_ocr_image(image_base64: str) -> tuple[bytes, str | None]:
    """Decode an OCR image payload to raw bytes and its content type.

    Mistral OCR returns each image as a data URL (``data:image/jpeg;base64,…``); a bare base64
    string is tolerated and stored with no declared type.
    """
    header, separator, encoded = image_base64.partition(",")
    if separator and header.startswith("data:"):
        content_type = header[len("data:") :].split(";", 1)[0] or None
        return base64.b64decode(encoded), content_type
    return base64.b64decode(image_base64), None


@workflows.activity(
    name="document_annotation_ui.document_ocr",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def document_annotation_ui_document_ocr(
    document_key: str | None = None,
    file_name: str | None = None,
    mime_type: str | None = None,
) -> OcrDocumentResult:
    """OCR a document held in object storage."""
    if not document_key:
        raise ValueError(
            "document_annotation_ui_document_ocr requires a document_key"
        )
    client = get_mistral_client()
    encoded = base64.b64encode(await get_document(document_key)).decode("ascii")

    doc_mime = mime_type or "application/octet-stream"
    doc_url = f"data:{doc_mime};base64,{encoded}"

    response = await client.ocr.process_async(
        model=document_annotation_ui_env.document_annotation_ui_ocr_model,
        document={"type": "document_url", "document_url": doc_url},
        include_image_base64=True,
        include_blocks=True,
    )

    all_pages_markdown: list[str] = []
    all_pages: list[OcrPageResult] = []
    pending_images: list[tuple[str, bytes, str | None]] = []
    confidences: list[float] = []

    for page in response.pages:
        if page.markdown:
            all_pages_markdown.append(page.markdown)

        page_image_ids: list[str] = []
        for img in page.images or []:
            if img.image_base64 and img.id:
                content, content_type = _decode_ocr_image(img.image_base64)
                pending_images.append((img.id, content, content_type))
                page_image_ids.append(img.id)

        if page.confidence_scores is not None:
            confidences.append(page.confidence_scores.average_page_confidence_score)

        width = page.dimensions.width if page.dimensions else 0
        height = page.dimensions.height if page.dimensions else 0
        blocks = [
            OcrBlockResult(
                content=block.content,
                type=getattr(block, "type", "text"),
                top_left_x=block.top_left_x,
                top_left_y=block.top_left_y,
                bottom_right_x=block.bottom_right_x,
                bottom_right_y=block.bottom_right_y,
            )
            # The SDK models blocks as an open union with an `UnknownBlock` fallback that carries
            # none of the coordinate fields; skip it rather than AttributeError on a new variant.
            for block in (page.blocks or [])
            if not getattr(block, "is_unknown", False)
        ]

        all_pages.append(
            OcrPageResult(
                index=page.index,
                width=width,
                height=height,
                blocks=blocks,
                image_ids=page_image_ids,
            )
        )

    # Keep image bytes out of Temporal state.
    await put_document_images(document_key, pending_images)

    return OcrDocumentResult(
        ocr_text="\n\n---\n\n".join(all_pages_markdown),
        page_count=len(all_pages),
        page_confidences=confidences if confidences else None,
        pages=all_pages,
    )


def _format_source_blocks(pages: list[OcrPageResult]) -> str:
    """Build a numbered source block list from OCR pages for the extraction LLM."""
    lines: list[str] = []
    source_idx = 0
    for page in pages:
        for block in page.blocks:
            lines.append(
                f"[source_{source_idx}] (page {page.index}, {block.type}) {block.content}"
            )
            source_idx += 1
    return "\n\n".join(lines)


def _source_map(
    citations: list[SourceCitation], allowed: set[str]
) -> dict[str, list[str]]:
    source_map: dict[str, list[str]] = {}
    for citation in citations:
        if citation.path.split(".", 1)[0] not in allowed:
            continue
        source_ids = source_map.setdefault(citation.path, [])
        for source_id in citation.source_ids:
            if source_id not in source_ids:
                source_ids.append(source_id)
    return source_map


async def document_annotation_ui_document_extract(
    pages: list[OcrPageResult],
    schema_name: str,
    prompt: str,
    expected_schema: dict[str, object],
) -> ExtractedDocument:
    document_type = resolve_document_type_for_schema(schema_name, expected_schema)

    user_content = f"OCR source blocks:\n{_format_source_blocks(pages)}"

    response_format = create_model(
        "DocumentExtractionStructuredOutput",
        __base__=DocumentExtractionStructuredOutput,
        data=(document_type, ...),
    )

    effort = document_annotation_ui_env.document_annotation_ui_extract_reasoning_effort
    request_kwargs: dict[str, object] = {}
    if effort.strip().lower() not in ("", "none", "off"):
        request_kwargs["reasoning_effort"] = effort

    parsed = await lechat.chat_parse_to_model(
        response_format,
        lechat.ChatCompletionRequest(
            model=document_annotation_ui_env.document_annotation_ui_extract_model,
            temperature=document_annotation_ui_env.document_annotation_ui_extract_temperature,
            top_p=document_annotation_ui_env.document_annotation_ui_extract_top_p,
            random_seed=document_annotation_ui_env.document_annotation_ui_extract_random_seed,
            messages=[
                lechat.SystemMessage(content=prompt),
                lechat.UserMessage(content=user_content),
            ],
            **request_kwargs,
        ),
    )

    return ExtractedDocument(
        data=parsed.data.model_dump(mode="json", by_alias=True),
        sources=_source_map(
            parsed.source_citations,
            set(expected_schema.get("properties", {})),
        ),
    )
