"""Object-storage layer tests, driven against bucket's own ``InMemoryBucket``.

The double ships with the backend this capability uses, so it raises the same
``BlobNotFoundError`` ``S3Bucket`` does and a round-trip here exercises every line of
storage.py except the ``S3Bucket`` construction branch. Using the shipped double rather than
a local stub means these tests also hold bucket to its own missing-object contract: a regression
there fails here instead of surfacing only against live S3. The live s3/bucket round-trip stays an
E2E concern.
"""

import pytest

from mistralai_capabilities.document_annotation_ui import storage
from mistralai_capabilities.document_annotation_ui.storage import (
    DocumentNotFoundError,
    DocumentStorageUnavailableError,
    document_key,
    get_document,
    is_owned_document,
    open_document_storage,
    put_document,
)
from mistralai_capabilities.bucket import InMemoryBucket

_USER = "user-1"


class _FakeIngestionEnv:
    """Stands in for ``env.ingestion.env``, whose real value is app-supplied."""

    def __init__(self, **overrides: object) -> None:
        self.ingestion_storage_backend = "filesystem"
        self.ingestion_filesystem_root = ""
        self.ingestion_s3_bucket = ""
        self.ingestion_s3_region = ""
        self.ingestion_s3_endpoint_url = ""
        self.ingestion_s3_access_key_id = ""
        self.ingestion_s3_secret_access_key = ""
        self.ingestion_s3_session_token = ""
        for key, value in overrides.items():
            setattr(self, key, value)


@pytest.fixture
def fake_storage(monkeypatch: pytest.MonkeyPatch) -> InMemoryBucket:
    """One double for the whole test, so its dict survives the separate `async with` opens."""
    fake = InMemoryBucket()
    monkeypatch.setattr(storage, "open_document_storage", lambda: fake)
    return fake


def test_document_key_binds_the_owner_and_keeps_the_basename() -> None:
    key = document_key("statement.pdf", user_id=_USER)

    prefix, owner, unique, name = key.rsplit("/", 3)
    assert prefix == "document_annotation_ui/documents"
    assert len(owner) == 64  # sha256 hex
    assert name == "statement.pdf"
    assert len(unique) == 36  # uuid4 str
    assert document_key("statement.pdf", user_id=_USER) != key


def test_is_owned_document_accepts_the_owner_and_rejects_others() -> None:
    key = document_key("a.pdf", user_id=_USER)
    assert is_owned_document(key, _USER) is True
    assert is_owned_document(key, "someone-else") is False


@pytest.mark.parametrize(
    "key",
    [
        "document_annotation_ui/documents/nope/missing.pdf",  # owner segment not a sha256
        "document_annotation_ui/documents/" + "a" * 64 + "/../../" + "b" * 64 + "/x/doc.pdf",  # traversal
        "other/prefix/" + "a" * 64 + "/11111111-1111-1111-1111-111111111111/x.pdf",  # wrong prefix
        "",
    ],
)
def test_is_owned_document_rejects_malformed_or_traversal_keys(key: str) -> None:
    assert is_owned_document(key, _USER) is False


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("../../etc/passwd", "passwd"),
        ("/absolute/path/doc.pdf", "doc.pdf"),
        ("..\\..\\windows\\system32\\evil.pdf", "evil.pdf"),
        ("C:\\Users\\me\\report.pdf", "report.pdf"),
        ("nested/dir/report.pdf", "report.pdf"),
        ("..", "document"),
        ("", "document"),
        ("   ", "document"),
    ],
)
def test_document_key_sanitizes_traversal_out_of_the_filename(raw: str, expected: str) -> None:
    assert document_key(raw, user_id=_USER).rsplit("/", 1)[-1] == expected


@pytest.mark.asyncio
async def test_put_and_get_document_round_trip_through_the_blob_backend(
    fake_storage: InMemoryBucket,
) -> None:
    content = b"%PDF-1.7 fake document bytes"

    key = await put_document(content, "statement.pdf", "application/pdf", user_id=_USER)

    assert is_owned_document(key, _USER)
    assert key.endswith("/statement.pdf")
    assert fake_storage.blobs[key] == content
    assert await get_document(key) == content


@pytest.mark.asyncio
async def test_put_document_sanitizes_the_stored_key(fake_storage: InMemoryBucket) -> None:
    key = await put_document(b"x", "../../../etc/passwd", user_id=_USER)

    assert key.endswith("/passwd")
    assert is_owned_document(key, _USER)
    assert key in fake_storage.blobs


@pytest.mark.asyncio
async def test_get_document_maps_a_missing_object_to_the_domain_error(fake_storage: InMemoryBucket) -> None:
    with pytest.raises(DocumentNotFoundError, match="document_annotation_ui/documents/nope/missing.pdf"):
        await get_document("document_annotation_ui/documents/nope/missing.pdf")


def test_open_document_storage_builds_the_s3_backend_with_empty_strings_as_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        storage,
        "ingestion_env",
        _FakeIngestionEnv(
            ingestion_storage_backend="s3",
            ingestion_s3_bucket="document-annotation-ui-documents",
            ingestion_s3_region="us-east-1",
            ingestion_s3_endpoint_url="http://localhost:9000",
            ingestion_s3_access_key_id="key",
            ingestion_s3_secret_access_key="secret",
            ingestion_s3_session_token="",
        ),
    )

    opened = open_document_storage()

    from mistralai_capabilities.bucket import S3Bucket

    assert isinstance(opened, S3Bucket)
    assert opened.aws_session_token is None


# The settings field deliberately accepts any string and defers validation to
# `open_document_storage()`. `carrier-pigeon` pins the domain error for unknown values as well as
# known legacy backends.
@pytest.mark.parametrize("backend", ["filesystem", "gcs", "azure", "carrier-pigeon"])
def test_open_document_storage_rejects_every_non_s3_backend(
    monkeypatch: pytest.MonkeyPatch, backend: str
) -> None:
    monkeypatch.setattr(storage, "ingestion_env", _FakeIngestionEnv(ingestion_storage_backend=backend))

    with pytest.raises(DocumentStorageUnavailableError, match=backend):
        open_document_storage()


def test_open_document_storage_rejects_an_unset_s3_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        storage,
        "ingestion_env",
        _FakeIngestionEnv(ingestion_storage_backend="s3", ingestion_s3_bucket=""),
    )

    with pytest.raises(DocumentStorageUnavailableError, match="ingestion_s3_bucket"):
        open_document_storage()
