import asyncio
import io
import typing
import urllib.parse as url_parse
from collections import defaultdict
from datetime import datetime
from typing import Any, Optional

import aiohttp
import structlog
import typing_extensions
from aiohttp import ClientResponseError
from gcloud.aio.storage import Storage
from typing_extensions import Self

from .base import BlobNotFoundError, BlobProperties, Bucket

_GCE_METADATA_EMAIL_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"

# Using the same value as in azure storage
MAX_DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024
MAX_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024  # 8MB chunks for upload

logger = structlog.get_logger(__name__)


class ChunkUploadContext(typing.TypedDict):
    session_uri: typing_extensions.NotRequired[str]
    content_buffer: typing_extensions.NotRequired[io.BytesIO]
    total_size: typing_extensions.NotRequired[int]
    position: typing_extensions.NotRequired[int]
    content_type: typing_extensions.NotRequired[str]


class GCSBucket(Bucket):
    _gcs_max_delete_blobs = 1000

    def __init__(
        self,
        bucket_id: str,
        storage: Optional[Storage] = None,
        prefix: Optional[str] = "",
        service_account_email: str | None = None,
    ) -> None:
        self.bucket_id = bucket_id
        self.prefix = prefix
        self.upload_chunk_contexts: defaultdict[str, ChunkUploadContext] = defaultdict(lambda: ChunkUploadContext())
        self.storage_cache: Optional[Storage] = storage
        self.cleanup_storage = storage is None
        self.service_account_email = service_account_email
        self._metadata_email_fetched = False
        self._metadata_email_lock = asyncio.Lock()

    async def __aenter__(self) -> Self:
        if self.storage_cache is None:
            self.storage_cache = Storage()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if self.cleanup_storage and self.storage_cache:
            await self.storage_cache.close()
            self.storage_cache = None

    def _add_prefix(self, key: str) -> str:
        """Add the prefix to the key."""
        if self.prefix and not key.startswith(self.prefix):
            return f"{self.prefix}{key}"
        return key

    async def _get_storage(self) -> Storage:
        """Get a Storage instance, either from cache or create a new one"""
        if self.storage_cache is None:
            self.storage_cache = Storage()
        return self.storage_cache

    async def upload_blob(
        self,
        key: str,
        content: bytes | typing.BinaryIO | typing.AsyncIterable[bytes],
        overwrite: bool = True,
        content_type: str | None = None,
        **upload_kwargs: typing.Any,
    ) -> str:
        if not overwrite:
            raise NotImplementedError("GCSBucket only support overwrite=True")
        prefixed_key = self._add_prefix(key)
        storage = await self._get_storage()
        if content_type:
            upload_kwargs.setdefault("content_type", content_type)
        if isinstance(content, typing.AsyncIterable):
            # `gcloud.aio`'s `Storage.upload` only accepts bytes/str/file-like input; handing it
            # an (async) iterator raises `TypeError: unsupported upload type`. Buffer the stream
            # into a file-like object first, mirroring `upload_chunk`.
            #
            # TRADEOFF: this reads the whole stream into memory before uploading, so a very large
            # blob is held entirely in RAM. That matches `upload_chunk`'s existing behaviour and is
            # fine for typical documents, but `gcloud.aio`'s simple `upload` cannot stream from an
            # async iterator at all — genuinely large blobs need its resumable/chunked upload API.
            # SAFETY: guarded by the isinstance(content, AsyncIterable) check above
            async_content = typing.cast(typing.AsyncIterable[bytes], content)
            buffer = io.BytesIO()
            async for chunk in async_content:
                buffer.write(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
            buffer.seek(0)
            content = buffer
        response = await storage.upload(
            bucket=self.bucket_id,
            object_name=prefixed_key,
            file_data=content,
            **upload_kwargs,
        )
        return str(response.get("selfLink"))

    async def upload_chunk(
        self,
        key: str,
        content: bytes | typing.BinaryIO | typing.AsyncIterable[bytes],
        **upload_kwargs: typing.Any,
    ) -> None:
        prefixed_key = self._add_prefix(key)
        upload_chunk_context = self.upload_chunk_contexts[prefixed_key]
        if "content_buffer" not in upload_chunk_context:
            upload_chunk_context["content_buffer"] = io.BytesIO()
            upload_chunk_context["content_type"] = upload_kwargs.get("content_type", "application/octet-stream")

        content_buffer = upload_chunk_context["content_buffer"]
        if isinstance(content, typing.AsyncIterable):
            async for chunk in content:
                content_buffer.write(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
        elif hasattr(content, "read"):
            # file-like obj handling
            content_bytes = content.read()
            if isinstance(content_bytes, str):
                content_bytes = content_bytes.encode("utf-8")
            content_buffer.write(content_bytes)
        else:
            if isinstance(content, str):
                content = content.encode("utf-8")
            content_buffer.write(content)

    async def finish_upload_chunk(self, key: str) -> None:
        prefixed_key = self._add_prefix(key)
        upload_chunk_context = self.upload_chunk_contexts[prefixed_key]
        if "content_buffer" not in upload_chunk_context:
            logger.warning(
                "GCSBucket.finish_upload_chunk called with no content_buffer in upload_chunk_context.",
            )
            self.upload_chunk_contexts.pop(prefixed_key)
            return
        storage = await self._get_storage()
        content_buffer = upload_chunk_context["content_buffer"]
        content_buffer.seek(0)
        await storage.upload(
            bucket=self.bucket_id,
            object_name=prefixed_key,
            file_data=content_buffer,
            content_type=upload_chunk_context.get("content_type", "application/octet-stream"),
        )
        content_buffer.close()
        self.upload_chunk_contexts.pop(prefixed_key)

    async def _resolve_service_account_email(self) -> str | None:
        if self.service_account_email:
            return self.service_account_email
        async with self._metadata_email_lock:
            if self.service_account_email:
                return self.service_account_email
            if self._metadata_email_fetched:
                return None
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        _GCE_METADATA_EMAIL_URL,
                        headers={"Metadata-Flavor": "Google"},
                        timeout=aiohttp.ClientTimeout(total=2),
                    ) as resp:
                        if resp.status == 200:
                            self.service_account_email = (await resp.text()).strip()
                            return self.service_account_email
            except Exception:
                pass
            self._metadata_email_fetched = True
            return None

    async def generate_signed_url(
        self,
        key: str,
        read_permission: bool,
        write_permission: bool,
        expiration_time_seconds: int,
        filename: str | None = None,
    ) -> str:
        prefixed_key = self._add_prefix(key)
        storage = await self._get_storage()

        bucket = storage.get_bucket(self.bucket_id)
        if read_permission:
            try:
                blob = await bucket.get_blob(blob_name=prefixed_key)
            except ClientResponseError as e:
                if e.status == 404:
                    raise BlobNotFoundError(blob_name=prefixed_key, storage_info=self.storage_info())
                raise
        else:
            blob = bucket.new_blob(blob_name=prefixed_key)

        query_params: dict[str, str] | None = None
        if read_permission and filename is not None:
            query_params = {
                "response-content-disposition": f"attachment; filename={url_parse.quote(filename)}",
            }

        url = await blob.get_signed_url(
            expiration=expiration_time_seconds,
            http_method="GET" if read_permission else "PUT",
            query_params=query_params,
            service_account_email=await self._resolve_service_account_email(),
        )
        return url

    def get_blob_key_from_url(self, url: str) -> str:
        """
        Extract the blob key from a GCS URL.

        Supports URL formats:
        - gs://{bucket_name}/{blob_key}
        - https://{bucket_name}.storage.googleapis.com/{blob_key}
        - https://storage.googleapis.com/{bucket_name}/{blob_key}
        - https://storage.cloud.google.com/{bucket_name}/{blob_key}
        - https://www.googleapis.com/storage/v1/b/{bucket_name}/o/{blob_key}  (JSON API `selfLink`)

        The returned key is the raw path segment (still percent-encoded); callers
        that need the literal object name should ``unquote`` it once.
        """
        parsed = url_parse.urlparse(url)
        cleaned_path = parsed.path.lstrip("/")

        if parsed.scheme == "gs":
            if parsed.netloc != self.bucket_id:
                raise ValueError(f"URL bucket '{parsed.netloc}' does not match expected bucket '{self.bucket_id}'.")
            return cleaned_path

        # JSON API resource URL, i.e. the `selfLink` that `upload_blob` returns:
        # https://www.googleapis.com/storage/v1/b/{bucket}/o/{url-encoded object name}
        # Must be handled before the path-style branch, since the object name here is
        # percent-encoded (slashes as %2F) and the `.../o/` layout differs from path-style.
        json_api_prefix = "/storage/v1/b/"
        if parsed.netloc in ("www.googleapis.com", "storage.googleapis.com") and parsed.path.startswith(
            json_api_prefix
        ):
            bucket, separator, key = parsed.path[len(json_api_prefix) :].partition("/o/")
            if not separator:
                raise ValueError(f"Unrecognized or unsupported GCS URL format: {url}")
            if bucket != self.bucket_id:
                raise ValueError(f"URL path does not match expected bucket '{self.bucket_id}'.")
            return key

        if parsed.netloc == f"{self.bucket_id}.storage.googleapis.com":
            return cleaned_path

        if parsed.netloc in ("storage.googleapis.com", "storage.cloud.google.com"):
            bucket, _, key = cleaned_path.partition("/")
            if bucket != self.bucket_id:
                raise ValueError(f"URL path does not match expected bucket '{self.bucket_id}'.")
            return key

        raise ValueError(f"Unrecognized or unsupported GCS URL format: {url}")

    async def get_chunks(
        self,
        key: str,
        offset: typing.Optional[int] = None,
        length: typing.Optional[int] = None,
        recreate_client: bool = False,
    ) -> typing.AsyncIterator[bytes]:
        prefixed_key = self._add_prefix(key)
        storage = await self._get_storage()

        bucket = storage.get_bucket(self.bucket_id)
        if not (await bucket.blob_exists(blob_name=prefixed_key)):
            raise BlobNotFoundError(prefixed_key, storage_info=self.storage_info())

        async def _chunks_iterator() -> typing.AsyncIterator[bytes]:
            inner_storage = await self._get_storage()

            headers = {}
            if offset is not None and length is not None:
                headers["Range"] = f"bytes={offset}-{offset + length - 1}"
            try:
                stream = await inner_storage.download_stream(
                    bucket=self.bucket_id,
                    object_name=prefixed_key,
                    headers=headers,
                )
            except ClientResponseError as e:
                if e.status == 404:
                    raise BlobNotFoundError(blob_name=prefixed_key, storage_info=self.storage_info())
                raise
            async with stream as s:
                async for chunk in s.content.iter_chunks():
                    yield chunk[0]

        return _chunks_iterator()

    async def get_blob(self, key: str) -> bytes:
        prefixed_key = self._add_prefix(key)
        storage = await self._get_storage()

        bucket = storage.get_bucket(self.bucket_id)
        try:
            blob = await bucket.get_blob(prefixed_key)
        except ClientResponseError as e:
            if e.status == 404:
                raise BlobNotFoundError(blob_name=prefixed_key, storage_info=self.storage_info())
            raise
        # SAFETY: blob fetched above (404 raised otherwise); gcloud.aio download() returns the object bytes
        return typing.cast(bytes, await blob.download())

    async def _iter_objects(self, prefix: str | None = None, page_size: int = 1000) -> typing.AsyncIterator[dict]:
        """Yield objects under ``prefix`` (or the whole bucket when ``None``), following ``nextPageToken``.

        ``None`` lists the entire bucket; ``""`` lists the storage root, i.e. the
        configured ``self.prefix`` is still applied via ``_add_prefix``.
        """
        storage = await self._get_storage()
        prefixed_prefix = self._add_prefix(prefix) if prefix is not None else None
        paginated_response = await storage.list_objects(
            bucket=self.bucket_id,
            params={"maxResults": str(page_size)} | ({"prefix": prefixed_prefix} if prefixed_prefix else {}),
        )
        for item in paginated_response.get("items", []):
            yield item
        while next_token := paginated_response.get("nextPageToken"):
            paginated_response = await storage.list_objects(
                bucket=self.bucket_id,
                params={"pageToken": str(next_token), "maxResults": str(page_size)}
                | ({"prefix": prefixed_prefix} if prefixed_prefix else {}),
            )
            for item in paginated_response.get("items", []):
                yield item

    async def list_blobs_with_prefix(self, prefix: str) -> typing.List[BlobProperties]:
        return [self.format_blob_properties(blob) async for blob in self._iter_objects(prefix)]

    async def delete_all_blobs(self, prefix: str | None = None) -> None:
        """
        This is potentially a long running operation.
        """
        found = True
        # do it multiple times to handle failures
        while found:
            found = False
            batch = []
            async for blob in self._iter_objects(prefix):
                batch.append(blob["name"])
                if len(batch) == self._gcs_max_delete_blobs:
                    found = True
                    await self.delete(batch, raise_on_any_failure=False)
                    batch.clear()
            # delete the remaining blobs
            if batch:
                await self.delete(batch, raise_on_any_failure=False)
                found = True

    async def delete(self, keys: list[str], raise_on_any_failure: bool = True) -> None:
        prefixed_keys = [self._add_prefix(key) for key in keys]
        storage = await self._get_storage()

        semaphore = asyncio.Semaphore(self._gcs_max_delete_blobs)
        tasks = [self._single_delete(storage, key, semaphore, raise_on_any_failure) for key in prefixed_keys]
        await asyncio.gather(*tasks)

    async def _single_delete(
        self, storage: Storage, key: str, semaphore: asyncio.Semaphore, raise_on_failure: bool = True
    ) -> None:
        async with semaphore:
            try:
                await storage.delete(bucket=self.bucket_id, object_name=key)
            except Exception:
                if raise_on_failure:
                    raise
                else:
                    logger.warning("Failed to delete blob", key=key, exc_info=True)

    async def delete_existing(self, key: str) -> None:
        prefixed_key = self._add_prefix(key)
        storage = await self._get_storage()

        bucket = storage.get_bucket(self.bucket_id)
        if await bucket.blob_exists(blob_name=prefixed_key):
            await storage.delete(
                bucket=self.bucket_id,
                object_name=prefixed_key,
            )

    async def get_blob_properties(self, key: str) -> BlobProperties:
        prefixed_key = self._add_prefix(key)
        storage = await self._get_storage()

        try:
            blob_metadata = await storage.download_metadata(bucket=self.bucket_id, object_name=prefixed_key)
        except ClientResponseError as e:
            if e.status == 404:
                raise BlobNotFoundError(blob_name=prefixed_key, storage_info=self.storage_info())
            raise
        return BlobProperties(
            name=blob_metadata["name"],
            size=int(blob_metadata["size"]),
            last_modified=datetime.fromisoformat(blob_metadata["updated"]),
        )

    @staticmethod
    def format_blob_properties(blob_properties: dict) -> BlobProperties:
        return BlobProperties(
            name=blob_properties["name"],
            size=int(blob_properties["size"]),
            # `updated` arrives as an RFC-3339 string; `BlobProperties.last_modified` is a
            # datetime, same as the sibling formatter three lines above parses it to.
            last_modified=datetime.fromisoformat(blob_properties["updated"]),
        )

    def storage_info(self) -> dict[str, str]:
        return {"provider": "gcs", "bucket_id": self.bucket_id}

    def get_upload_headers(self) -> dict[str, str] | None:
        return None

    async def ensure_container_exists(self) -> None:
        pass
