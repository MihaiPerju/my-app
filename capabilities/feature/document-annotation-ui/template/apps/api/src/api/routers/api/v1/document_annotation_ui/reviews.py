"""The document a review was run against, streamed back from object storage.

The reviews list is not here: ``WorkflowRouter`` auto-mounts ``GET /executions``, and it is
caller-scoped correctly because it reads the ownership store, not the platform account. This module
adds the Document Annotation UI-specific part: fetch the stored document by run, so reopening a
review renders the
original page without the upload still held in the tab.
"""

import unicodedata
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response
from mistralai_capabilities.document_annotation_ui.api import (
    ExecutionRoute,
    RequireOwned,
    load_review_state,
    owned_document_key,
)
from mistralai_capabilities.document_annotation_ui.schemas import (
    FALLBACK_MIME_TYPE,
    safe_media_type,
)
from mistralai_capabilities.document_annotation_ui.storage import (
    DocumentNotFoundError,
    DocumentStorageUnavailableError,
    get_document,
    get_document_image,
)
from mistralai_capabilities.fastapi_auth.identity import CurrentUser
from mistralai_capabilities.fastapi_workflows_auth.commands import Commands

_FALLBACK_FILE_NAME = "document"

router = APIRouter(route_class=ExecutionRoute)


def _content_disposition(file_name: str | None) -> str:
    """``inline`` under a filename a header can actually carry.

    Normalise to NFC and use a bare ``filename=`` when ASCII, otherwise a degraded ASCII name plus
    the real one in the RFC 5987 ``filename*`` form. The name is caller-supplied, so ``\\``, ``"``
    and C0 controls are stripped: each one ends the header early or closes the quoted-string, a
    response-splitting primitive.
    """
    name = "".join(
        char
        for char in unicodedata.normalize("NFC", file_name or "")
        if char not in '"\\' and (ord(char) >= 0x20 and ord(char) != 0x7F)
    ).strip()
    if not name:
        name = _FALLBACK_FILE_NAME
    try:
        name.encode("ascii")
    except UnicodeEncodeError:
        ascii_fallback = name.encode("ascii", "replace").decode("ascii")
        return f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(name)}"
    return f'inline; filename="{name}"'


@router.get(
    "/{execution_id}/document",
    operation_id="document_annotation_ui_document_extraction_review_document",
    response_class=Response,
    responses={
        200: {
            "content": {FALLBACK_MIME_TYPE: {"schema": {"type": "string", "format": "binary"}}},
            "description": "The document the run was started with, as stored.",
        },
        404: {"description": "The run is not this caller's, or it holds no stored document"},
        503: {"description": "No object-storage backend is configured for documents"},
    },
    dependencies=[RequireOwned],
)
async def get_review_document(
    execution_id: str,
    commands: Commands,
    user: CurrentUser,
) -> Response:
    """The document a run was started with, read back from object storage.

    The key is derived SERVER-SIDE from the run's own ``review_state``, never from the request:
    the ownership check would be decorative if the caller still chose the key it applied to. It is
    re-checked with ``owned_document_key`` because a legacy run can carry a key its caller never
    uploaded, and only then streamed.
    """
    state = await load_review_state(commands, execution_id)
    document_key = owned_document_key(state, user.user_id)

    try:
        content = await get_document(document_key)
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail="The stored document is gone") from error
    except DocumentStorageUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    return Response(
        content=content,
        media_type=safe_media_type(state.mime_type),
        headers={
            "Content-Disposition": _content_disposition(state.file_name),
            "X-Content-Type-Options": "nosniff",
            # An uploaded document can be HTML/SVG; served inline it would otherwise execute in
            # this app's origin (stored XSS). `sandbox` renders it in an opaque origin with scripts
            # disabled, so PDFs/images still display but active content cannot run.
            "Content-Security-Policy": "sandbox",
        },
    )


_IMAGE_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def _image_media_type(content: bytes) -> str:
    """Sniff a stored OCR image's type from its magic bytes.

    The bytes come from our own OCR pipeline, but the content type is not stored alongside them, so
    it is read back from the signature rather than trusted from the request. WEBP is RIFF-framed.
    """
    for signature, media_type in _IMAGE_SIGNATURES:
        if content.startswith(signature):
            return media_type
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return FALLBACK_MIME_TYPE


@router.get(
    "/{execution_id}/images/{image_id}",
    operation_id="document_annotation_ui_document_extraction_review_image",
    response_class=Response,
    responses={
        200: {
            "content": {"image/png": {"schema": {"type": "string", "format": "binary"}}},
            "description": "An OCR page image for the run, as stored.",
        },
        404: {"description": "The run is not this caller's, or the image is not stored"},
        503: {"description": "No object-storage backend is configured for documents"},
    },
    dependencies=[RequireOwned],
)
async def get_review_document_image(
    execution_id: str,
    image_id: str,
    commands: Commands,
    user: CurrentUser,
) -> Response:
    """An OCR page image, read back from object storage.

    Like the document itself, the storage key is derived SERVER-SIDE from the run's own
    ``review_state`` document key (re-checked with ``owned_document_key``) and the ``image_id`` path
    segment, which ``document_image_key`` confines to that document's image namespace — the caller
    never supplies a raw key.
    """
    state = await load_review_state(commands, execution_id)
    document_key = owned_document_key(state, user.user_id)

    try:
        content = await get_document_image(document_key, image_id)
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail="The stored image is gone") from error
    except DocumentStorageUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    return Response(
        content=content,
        media_type=_image_media_type(content),
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )
