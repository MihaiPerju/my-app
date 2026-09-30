"""Staging a document into object storage, ahead of an extraction run.

The browser POSTs the file here once, and the extraction run then carries only the returned
``document_key``. Keeping the bytes out of the run payload lifts the size cap from the inline
path's ~1.5 MB to ``MAX_DOCUMENT_BYTES``.
"""

from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile
from mistralai_capabilities.document_annotation_ui.schemas import (
    MAX_DOCUMENT_BYTES,
    UploadResult,
    safe_media_type,
)
from mistralai_capabilities.document_annotation_ui.storage import (
    DocumentStorageUnavailableError,
    put_document,
)
from mistralai_capabilities.fastapi_auth.identity import CurrentUser

_DEFAULT_FILE_NAME = "document"
_TOO_LARGE = f"The document exceeds the {MAX_DOCUMENT_BYTES} byte upload limit"
_READ_CHUNK_BYTES = 1024 * 1024

router = APIRouter()


@router.post(
    "",
    operation_id="document_annotation_ui_document_upload",
    responses={
        400: {"description": "The uploaded document is empty"},
        413: {"description": "The uploaded document is larger than the upload limit"},
        503: {"description": "No object-storage backend is configured for documents"},
    },
)
async def upload_document(user: CurrentUser, file: Annotated[UploadFile, File()]) -> UploadResult:
    # Read in chunks and reject once the running total crosses the cap, so a multi-GB upload cannot
    # be materialised in memory before the 413 fires. This bounds the RAM the read uses, but it is
    # only defence in depth: Starlette has already spooled the multipart body to a temp file during
    # parsing before this handler runs, so the request-BODY size limit belongs at the gateway that
    # fronts this app (it must reject over-large requests before the body is spooled). See INSTALL.md.
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(_READ_CHUNK_BYTES):
        total += len(chunk)
        if total > MAX_DOCUMENT_BYTES:
            raise HTTPException(status_code=413, detail=_TOO_LARGE)
        chunks.append(chunk)
    content = b"".join(chunks)
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded document is empty")

    file_name = file.filename or _DEFAULT_FILE_NAME
    # ``content_type`` is caller-controlled and is echoed onto the run payload, from where the OCR
    # activity builds a ``data:{mime};base64,...`` URL and the review route serves it as a response
    # header. Normalize it to the conservative media-type grammar (octet-stream on anything odd)
    # before it is persisted, so a value like ``text/plain,garbage`` cannot terminate the data-URL
    # metadata early or split a header downstream.
    mime_type = safe_media_type(file.content_type)

    try:
        document_key = await put_document(content, file_name, mime_type, user_id=user.user_id)
    except DocumentStorageUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    return UploadResult(
        document_key=document_key,
        file_name=file_name,
        mime_type=mime_type,
        size=len(content),
    )
