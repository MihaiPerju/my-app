"""Object storage for Document Annotation UI documents, on the bucket ``Bucket`` S3 backend.

Documents upload once to the ingestion backend and then travel through the workflow as a key. This
keeps the run payload small. The bytes are fetched at OCR time. The backend is S3-compatible only
(the bucket capability serves it locally); env.document_annotation_ui re-declares the same
INGESTION_* names search uses, so one deployment configures object storage for both capabilities.
"""

import hashlib
import re
from collections.abc import Iterable
from uuid import uuid4

from env.document_annotation_ui import env as ingestion_env
from mistralai_capabilities.bucket import BlobNotFoundError, Bucket

__all__ = [
    "DEFAULT_DOCUMENT_PREFIX",
    "DocumentNotFoundError",
    "DocumentStorageUnavailableError",
    "document_image_key",
    "document_key",
    "get_document",
    "get_document_image",
    "is_owned_document",
    "open_document_storage",
    "put_document",
    "put_document_images",
]

DEFAULT_DOCUMENT_PREFIX = "document_annotation_ui/documents"
_FALLBACK_FILENAME = "document"

# A key binds its uploader: <prefix>/<sha256(user_id)>/<uuid4>/<leaf>. The whole shape is matched,
# never a prefix, because `is_owned_document` is an authorization decision: the `owner` capture must
# be exactly one separator-free segment, or `…/<victim>/x/<mine>` would present the attacker's hash
# to the comparison while addressing someone else's object. S3 keys are opaque — nothing collapses
# `..` — so this is about pinning the capture, not about path traversal.
_KEY_RE = re.compile(
    rf"^{re.escape(DEFAULT_DOCUMENT_PREFIX)}/(?P<owner>[0-9a-f]{{64}})/[0-9a-f-]{{36}}/[^/\\]+$"
)

# OCR page images live beside their document: <prefix>/<owner>/<uuid>/images/<leaf>. The caller
# never supplies this key — it is derived from a run's own, already ownership-checked document_key —
# so ownership is the document's. `images` is a reserved segment, not a client leaf, so it needs no
# regex of its own.
_DOCUMENT_PARENT_RE = re.compile(
    rf"^(?P<parent>{re.escape(DEFAULT_DOCUMENT_PREFIX)}/[0-9a-f]{{64}}/[0-9a-f-]{{36}})/[^/\\]+$"
)
_IMAGE_SEGMENT = "images"


class DocumentStorageUnavailableError(RuntimeError):
    """Raised when no usable object-storage backend is configured for Document Annotation UI documents."""


class DocumentNotFoundError(RuntimeError):
    """Raised when a document key does not resolve to an object in the backend."""


def open_document_storage() -> Bucket:
    """Return an unopened S3 ``Bucket`` for the configured ingestion backend.

    The result is an async context manager; enter it before any read or write.

    S3 is the only backend this capability supports. Backend validation is deliberately deferred
    to this boundary so every configured string is representable and unsupported values consistently
    raise ``DocumentStorageUnavailableError``.
    """
    backend = ingestion_env.ingestion_storage_backend
    if backend != "s3":
        raise DocumentStorageUnavailableError(
            f"The {backend!r} ingestion backend is not supported for Intelligent Document "
            "Processing documents; use 's3'"
        )
    if not ingestion_env.ingestion_s3_bucket:
        raise DocumentStorageUnavailableError("ingestion_s3_bucket must be set for the s3 backend")

    from mistralai_capabilities.bucket import S3Bucket

    # Empty string is how an unset app setting arrives; the backend wants None to fall through to
    # the default AWS credential/endpoint chain.
    return S3Bucket(
        bucket_name=ingestion_env.ingestion_s3_bucket,
        region_name=ingestion_env.ingestion_s3_region or None,
        endpoint_url=ingestion_env.ingestion_s3_endpoint_url or None,
        aws_access_key_id=ingestion_env.ingestion_s3_access_key_id or None,
        aws_secret_access_key=ingestion_env.ingestion_s3_secret_access_key or None,
        aws_session_token=ingestion_env.ingestion_s3_session_token or None,
    )


def _safe_basename(filename: str) -> str:
    """Reduce a client-supplied filename to a leaf name that cannot escape the prefix.

    The name arrives from a browser upload and may carry a Windows path, so both separators
    collapse. A name of only separators or dots degrades to a constant, not an empty key segment.
    """
    candidate = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not candidate or set(candidate) <= {"."}:
        return _FALLBACK_FILENAME
    return candidate


def _owner_segment(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()


def document_key(filename: str, *, user_id: str) -> str:
    """Mint a collision-free storage key that binds the document to its uploader."""
    return f"{DEFAULT_DOCUMENT_PREFIX}/{_owner_segment(user_id)}/{uuid4()}/{_safe_basename(filename)}"


def is_owned_document(key: str, user_id: str) -> bool:
    """Whether ``key`` is a well-formed Document Annotation UI document key owned by ``user_id``."""
    match = _KEY_RE.match(key)
    return match is not None and match.group("owner") == _owner_segment(user_id)


async def _read(key: str, what: str) -> bytes:
    """Read one object, translating the backend's miss into this package's domain error.

    The translation lives here, once: `BlobNotFoundError` is bucket vocabulary and must not escape
    this module, and a caller that forgot to catch it would surface a storage exception through the
    API instead of a 404.
    """
    async with open_document_storage() as storage:
        try:
            return await storage.get_blob(key)
        except BlobNotFoundError as error:
            raise DocumentNotFoundError(f"No {what} stored at {key!r}") from error


async def put_document(content: bytes, filename: str, content_type: str | None = None, *, user_id: str) -> str:
    """Store document bytes under a freshly minted, uploader-bound key and return that key."""
    key = document_key(filename, user_id=user_id)
    async with open_document_storage() as storage:
        await storage.upload_blob(key, content, content_type=content_type)
    return key


async def get_document(key: str) -> bytes:
    """Read the document bytes stored under ``key``.

    Deliberately unauthenticated: this package has no requesting principal, so it cannot decide
    ownership without threading user_id through Temporal. The gate lives at the HTTP boundary, where
    the caller identity exists. document.py refuses a run whose document_key was not minted for the
    caller, and reviews.py re-checks before streaming a document back. A key embeds sha256(user_id)
    and a uuid4, so it is unguessable and only reachable after that gate.
    """
    return await _read(key, "document")


def document_image_key(document_key: str, image_id: str) -> str:
    """Derive the storage key for an OCR page image of ``document_key``.

    The image sits under the document's own <owner>/<uuid> namespace, so document ownership proves
    image ownership. image_id is reduced to a safe leaf. A malformed document key is rejected.
    """
    match = _DOCUMENT_PARENT_RE.match(document_key)
    if match is None:
        raise ValueError(f"Not a well-formed Document Annotation UI document key: {document_key!r}")
    return f"{match.group('parent')}/{_IMAGE_SEGMENT}/{_safe_basename(image_id)}"


async def put_document_images(
    document_key: str, images: Iterable[tuple[str, bytes, str | None]]
) -> None:
    """Store OCR page images beside their document, opening the backend once for the batch.

    Each item is ``(image_id, content, content_type)``. Keeping the bytes here — not in the
    workflow payload — is the whole point: a scanned page's images never ride Temporal state.
    """
    materialised = [(document_image_key(document_key, image_id), content, content_type) for image_id, content, content_type in images]
    if not materialised:
        return
    async with open_document_storage() as storage:
        for key, content, content_type in materialised:
            await storage.upload_blob(key, content, content_type=content_type)


async def get_document_image(document_key: str, image_id: str) -> bytes:
    """Read one OCR page image, by the document key it was stored beside and its id."""
    return await _read(document_image_key(document_key, image_id), "image")
