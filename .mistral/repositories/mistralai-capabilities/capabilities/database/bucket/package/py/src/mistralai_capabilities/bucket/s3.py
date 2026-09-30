import typing
import urllib.parse as url_parse
from collections import defaultdict
from typing import Any, AsyncContextManager, Awaitable, Callable, Optional, TypeVar

import aioboto3
import botocore
import botocore.config
import structlog
import typing_extensions
from types_aiobotocore_s3.client import S3Client
from types_aiobotocore_s3.literals import BucketLocationConstraintType
from types_aiobotocore_s3.type_defs import CompletedPartTypeDef, ObjectIdentifierTypeDef
from typing_extensions import AsyncIterable, Self

from .base import BlobNotFoundError, BlobProperties, Bucket

T = TypeVar("T")
logger = structlog.get_logger(__name__)

# S3 constants
MAX_DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024  # 4MB, same as in Azure storage
MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024  # S3 minimum 5MB per non-final part


class ChunkUploadContext(typing.TypedDict):
    multipart_upload_id: typing_extensions.NotRequired[str]
    parts: typing_extensions.NotRequired[list[dict[str, Any]]]
    content_type: typing_extensions.NotRequired[str]


class StorageError(Exception):
    """Base class for storage-related errors."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(self.message)


class S3Bucket(Bucket):
    """Manages blobs in an S3-compatible storage (AWS S3 or MinIO)."""

    _s3_max_delete_blobs = 1000

    def __init__(
        self,
        bucket_name: str,
        region_name: Optional[str] = None,
        endpoint_url: Optional[str] = None,
        public_endpoint_url: Optional[str] = None,
        aws_access_key_id: Optional[str] = None,
        aws_secret_access_key: Optional[str] = None,
        aws_session_token: Optional[str] = None,
        prefix: Optional[str] = "",
        signature_version: Optional[str] = None,
    ) -> None:
        """
        Initialize S3 blob storage.

        Args:
            bucket_name: The name of the S3 bucket.
            region_name: The AWS region (e.g., 'us-east-1'). Required for AWS S3, optional for MinIO.
            endpoint_url: Custom endpoint URL for non-AWS S3 providers like MinIO.
                          If provided, this will be used instead of the default AWS endpoints.
            public_endpoint_url: If provided, will overwrite the endpoint_url for the signed url generation
            aws_access_key_id: AWS access key ID. Required if not using instance profile.
            aws_secret_access_key: AWS secret access key. Required if not using instance profile.
            aws_session_token: AWS session token, for temporary (STS/assume-role) credentials.
            prefix: The prefix to use for all keys in the bucket.
            signature_version: S3 signature version ("s3" for V2, "s3v4" for V4).
                If None (default), uses botocore defaults.
        """

        self.bucket_name = bucket_name
        self.region_name = region_name
        self.endpoint_url = endpoint_url
        self.public_endpoint_url = public_endpoint_url
        self.aws_access_key_id = aws_access_key_id
        self.aws_secret_access_key = aws_secret_access_key
        self.aws_session_token = aws_session_token
        self.prefix = prefix
        self.signature_version = signature_version

        # Create session with credentials
        if aws_access_key_id and aws_secret_access_key:
            self.session = aioboto3.Session(
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                aws_session_token=aws_session_token,
                region_name=region_name,
            )
        # No explicit credentials, use default AWS chain (includes IRSA)
        else:
            self.session = aioboto3.Session(region_name=region_name)

        # Lazily create client contexts to avoid un-awaited coroutines when storage is only inspected
        self.s3_client_context: Optional[AsyncContextManager[S3Client]] = None
        self.s3_client: Optional[S3Client] = None
        self.public_s3_client_context: Optional[AsyncContextManager[S3Client]] = None
        self.public_s3_client: Optional[S3Client] = None

        self.upload_chunk_contexts: defaultdict[str, ChunkUploadContext] = defaultdict(lambda: ChunkUploadContext())

        # Add buffer tracking
        self._chunk_buffers: defaultdict[str, Optional[bytes]] = defaultdict(lambda: None)  # key -> buffered bytes
        self._min_part_size = 5 * 1024 * 1024  # 5MB minimum part size for S3 multipart uploads

    def _s3_client_kwargs(self, endpoint_url: Optional[str]) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"endpoint_url": endpoint_url}
        if self.signature_version:
            kwargs["config"] = botocore.config.Config(signature_version=self.signature_version)
        return kwargs

    async def __aenter__(self) -> Self:
        # Enter the client's context and store the actual client
        self.s3_client_context = self.session.client("s3", **self._s3_client_kwargs(self.endpoint_url))
        self.s3_client = await self.s3_client_context.__aenter__()
        if self.public_endpoint_url:
            try:
                self.public_s3_client_context = self.session.client(
                    "s3", **self._s3_client_kwargs(self.public_endpoint_url)
                )
                self.public_s3_client = await self.public_s3_client_context.__aenter__()
            except BaseException:
                # `__aexit__` never runs when `__aenter__` raises, so the first client would leak
                # its connection pool for the life of the process. Unwind it here.
                await self.s3_client_context.__aexit__(None, None, None)
                self.s3_client = None
                self.s3_client_context = None
                self.public_s3_client_context = None
                raise
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        # Exit the client's context
        if self.s3_client_context is not None:
            await self.s3_client_context.__aexit__(exc_type, exc_val, exc_tb)
        self.s3_client = None
        if self.public_s3_client_context is not None:
            await self.public_s3_client_context.__aexit__(exc_type, exc_val, exc_tb)
        self.public_s3_client = None
        self.s3_client_context = None
        self.public_s3_client_context = None

    def _ensure_client(self) -> S3Client:
        """Ensure the S3 client is initialized."""
        if self.s3_client is None:
            raise RuntimeError("S3 client not initialized. Use 'async with' context manager.")
        return self.s3_client

    def _ensure_public_client(self) -> S3Client:
        if self.public_s3_client_context is None:
            return self._ensure_client()
        if self.public_s3_client is None:
            raise RuntimeError("S3 client not initialized. Use 'async with' context manager.")
        return self.public_s3_client

    def _add_prefix(self, key: str) -> str:
        """Add the prefix to the key."""
        if self.prefix and not key.startswith(self.prefix):
            return f"{self.prefix}{key}"
        return key

    async def _abort_multipart_after_failure(
        self, s3_client: S3Client, prefixed_key: str, upload_id: str
    ) -> None:
        """Drop a multipart upload while already unwinding another error. Best effort.

        Only for the path where something else has already gone wrong: there the abort is cleanup,
        and an abort that itself fails must not replace the exception that caused it, or the caller
        is told the wrong thing went wrong. S3 keeps charging for uploaded parts until the upload
        is aborted or completed, so a leaked upload is a cost leak, not just an untidy bucket --
        hence the warning rather than silence.

        Do NOT reuse this where the abort IS the operation. Swallowing the failure there would
        report success over a still-billable upload; call `abort_multipart_upload` directly and let
        it raise.
        """
        try:
            await s3_client.abort_multipart_upload(
                Bucket=self.bucket_name,
                Key=prefixed_key,
                UploadId=upload_id,
            )
        except Exception as abort_error:
            logger.warning(
                "Failed to abort multipart upload; its parts stay billable until the bucket's "
                "lifecycle rule reaps them",
                key=prefixed_key,
                upload_id=upload_id,
                error=str(abort_error),
            )

    async def upload_blob(
        self,
        key: str,
        content: bytes | typing.BinaryIO | typing.AsyncIterable[bytes],
        overwrite: bool = True,
        content_type: str | None = None,
        **upload_kwargs: Any,
    ) -> str:
        """
        Upload a blob to S3 storage.

        Args:
            key: The key (path) of the blob in the bucket.
            content: The content to upload (either bytes or a file-like object).
            overwrite: Whether to overwrite the blob if it already exists.
            content_type: The content type of the blob. If not provided, it will be inferred.
            upload_kwargs: Additional keyword arguments for the S3 upload_fileobj operation.

        Returns:
            The URL of the uploaded blob.
        """
        if not overwrite:
            raise NotImplementedError("S3Bucket only support overwrite=True")
        s3_client = self._ensure_client()
        prefixed_key = self._add_prefix(key)
        if content_type:
            upload_kwargs.setdefault("ContentType", content_type)

        if isinstance(content, bytes):
            await s3_client.put_object(
                Bucket=self.bucket_name,
                Key=prefixed_key,
                Body=content,
                **upload_kwargs,
            )
        elif isinstance(content, AsyncIterable):
            # `upload_kwargs` carries ContentType: it must be set at CREATE time, because a
            # multipart object takes its metadata from the create call, not from the parts.
            mpu = await s3_client.create_multipart_upload(
                Bucket=self.bucket_name, Key=prefixed_key, **upload_kwargs
            )
            upload_id = mpu["UploadId"]
            part_number = 1
            parts: list[CompletedPartTypeDef] = []
            buffer = bytearray()
            try:
                async for chunk in content:
                    buffer.extend(chunk)
                    while len(buffer) >= MIN_MULTIPART_PART_SIZE:
                        part_data = bytes(buffer[:MIN_MULTIPART_PART_SIZE])
                        del buffer[:MIN_MULTIPART_PART_SIZE]
                        resp = await s3_client.upload_part(
                            Bucket=self.bucket_name,
                            Key=prefixed_key,
                            UploadId=upload_id,
                            PartNumber=part_number,
                            Body=part_data,
                        )
                        parts.append({"PartNumber": part_number, "ETag": resp["ETag"]})
                        part_number += 1
                if buffer:
                    resp = await s3_client.upload_part(
                        Bucket=self.bucket_name,
                        Key=prefixed_key,
                        UploadId=upload_id,
                        PartNumber=part_number,
                        Body=bytes(buffer),
                    )
                    parts.append({"PartNumber": part_number, "ETag": resp["ETag"]})
                # Completion is inside the boundary: a `complete_multipart_upload` that fails
                # leaves the upload and its billable parts behind exactly like a failed part does.
                if parts:
                    parts.sort(key=lambda p: p["PartNumber"])
                    await s3_client.complete_multipart_upload(
                        Bucket=self.bucket_name,
                        Key=prefixed_key,
                        UploadId=upload_id,
                        MultipartUpload={"Parts": parts},
                    )
            except Exception:
                await self._abort_multipart_after_failure(s3_client, prefixed_key, upload_id)
                raise

            if not parts:
                # S3 rejects a zero-part completion, so an empty stream has no upload to finish.
                # It is not an error: drop the upload and write the empty object the `bytes` branch
                # would have.
                #
                # This abort is the operation, not cleanup -- nothing has failed yet, so there is
                # no earlier error to protect and a failure here must surface. Swallowing it would
                # let `put_object` succeed and this method return a URL while the upload stays
                # open and billable. Deliberately NOT `_abort_multipart_after_failure`.
                await s3_client.abort_multipart_upload(
                    Bucket=self.bucket_name,
                    Key=prefixed_key,
                    UploadId=upload_id,
                )
                await s3_client.put_object(
                    Bucket=self.bucket_name,
                    Key=prefixed_key,
                    Body=b"",
                    **upload_kwargs,
                )
        else:
            await s3_client.upload_fileobj(
                content,
                self.bucket_name,
                prefixed_key,
                ExtraArgs=upload_kwargs,
            )

        # Return the URL of the uploaded blob
        if self.endpoint_url:
            # For custom endpoints (like MinIO)
            return f"{self.endpoint_url}/{self.bucket_name}/{prefixed_key}"
        else:
            # For AWS S3
            region = self.region_name or "us-east-1"
            return f"https://{self.bucket_name}.s3.{region}.amazonaws.com/{prefixed_key}"

    async def upload_chunk(
        self,
        key: str,
        content: bytes,
        **upload_kwargs: Any,
    ) -> None:
        """
        Buffer and upload a chunk of data for multipart upload.

        Chunks are buffered until they reach the 5MB minimum size required by S3.
        """
        prefixed_key = self._add_prefix(key)
        upload_chunk_context = self.upload_chunk_contexts[prefixed_key]
        content_type = upload_kwargs.pop(
            "content_type",
            upload_chunk_context.get("content_type"),
        )
        if isinstance(content_type, str):
            upload_chunk_context.setdefault("content_type", content_type)
            upload_kwargs.setdefault("ContentType", content_type)

        current_buffer = self._chunk_buffers.get(prefixed_key)
        if current_buffer is None:
            self._chunk_buffers[prefixed_key] = content
        else:
            self._chunk_buffers[prefixed_key] = current_buffer + content

        # Only proceed with upload if buffer is large enough
        buffer_content = self._chunk_buffers[prefixed_key]
        if buffer_content is None or len(buffer_content) < self._min_part_size:
            return  # Wait for more data

        # Extract buffered content for upload
        buffered_content = self._chunk_buffers[prefixed_key]
        self._chunk_buffers[prefixed_key] = None  # Clear buffer

        # Continue with normal upload process
        s3_client = self._ensure_client()

        # If this is the first chunk, start a multipart upload
        if "multipart_upload_id" not in upload_chunk_context:
            response = await s3_client.create_multipart_upload(
                Bucket=self.bucket_name,
                Key=prefixed_key,
                **upload_kwargs,
            )
            upload_id = response["UploadId"]
            upload_chunk_context["multipart_upload_id"] = upload_id
            upload_chunk_context["parts"] = []

        # Upload the chunk as a part
        multipart_upload_id = upload_chunk_context["multipart_upload_id"]
        parts = upload_chunk_context["parts"]
        part_number = len(parts) + 1

        part_response = await s3_client.upload_part(
            Bucket=self.bucket_name,
            Key=prefixed_key,
            PartNumber=part_number,
            UploadId=multipart_upload_id,
            Body=buffered_content,
        )

        # Save the ETag for this part
        parts.append(
            {
                "PartNumber": part_number,
                "ETag": part_response["ETag"],
            }
        )

    async def finish_upload_chunk(self, key: str) -> None:
        """
        Complete a multipart upload by combining all uploaded chunks.
        If the buffer was never large enough to start a multipart upload,
        falls back to a simple upload.
        """
        prefixed_key = self._add_prefix(key)
        s3_client = self._ensure_client()

        # access the upload context directly - defaultdict will create if needed
        upload_chunk_context = self.upload_chunk_contexts[prefixed_key]

        # Handle any remaining buffered content
        remaining_buffer = self._chunk_buffers.pop(prefixed_key, None)

        # CASE 1: No multipart upload started yet (buffer never hit min size)
        if "multipart_upload_id" not in upload_chunk_context:
            # Fall back to simple upload for the buffered content
            if remaining_buffer:
                await self.upload_blob(
                    key=prefixed_key,
                    content=remaining_buffer,
                    content_type=upload_chunk_context.get("content_type"),
                )

            # Clean up the context since we're done
            self.upload_chunk_contexts.pop(prefixed_key, None)
            return

        # CASE 2: Multipart upload was started - get the multipart info
        multipart_upload_id = upload_chunk_context["multipart_upload_id"]
        parts = upload_chunk_context["parts"]

        # If we have buffered content, upload it as the final part
        # (S3 allows the last part to be any size)
        if remaining_buffer:
            part_number = len(parts) + 1
            part_response = await s3_client.upload_part(
                Bucket=self.bucket_name,
                Key=prefixed_key,
                PartNumber=part_number,
                UploadId=multipart_upload_id,
                Body=remaining_buffer,
            )

            # Save the ETag for this part
            parts.append(
                {
                    "PartNumber": part_number,
                    "ETag": part_response["ETag"],
                }
            )

        # Check if we have any parts to complete the multipart upload
        if not parts:
            # Abort the orphaned multipart upload. Best effort: the ValueError below is the
            # caller's actual problem and must not be replaced by an abort failure.
            await self._abort_multipart_after_failure(s3_client, prefixed_key, multipart_upload_id)

            # raise error
            raise ValueError(
                f"Multipart upload started but no parts were uploaded for key: {prefixed_key}. "
                f"Upload at least one chunk before finishing."
            )
        else:
            # Complete the multipart upload
            await s3_client.complete_multipart_upload(
                Bucket=self.bucket_name,
                Key=prefixed_key,
                UploadId=multipart_upload_id,
                # SAFETY: parts entries are built with PartNumber/ETag matching CompletedPartTypeDef
                MultipartUpload={"Parts": typing.cast(typing.Sequence[CompletedPartTypeDef], parts)},
            )

        # Remove the context after successful completion
        self.upload_chunk_contexts.pop(prefixed_key, None)

    async def generate_signed_url(
        self,
        key: str,
        read_permission: bool,
        write_permission: bool,
        expiration_time_seconds: int,
        filename: str | None = None,
    ) -> str:
        """
        Generate a signed URL for the blob.

        Args:
            key: The key (path) of the blob in the bucket.
            read_permission: Whether the URL should allow read operations.
            write_permission: Whether the URL should allow write operations.
            expiration_time_seconds: The expiration time of the URL in seconds.

        Returns:
            The signed URL.

        Raises:
            BlobNotFoundError: If the blob does not exist.
        """
        prefixed_key = self._add_prefix(key)

        params: dict[str, Any] = {
            "Bucket": self.bucket_name,
            "Key": prefixed_key,
        }
        if read_permission and filename is not None:
            params["ResponseContentDisposition"] = f"attachment; filename={url_parse.quote(filename)}"

        s3_client = self._ensure_public_client()
        url = await s3_client.generate_presigned_url(
            ClientMethod="get_object" if read_permission else "put_object",
            Params=params,
            ExpiresIn=expiration_time_seconds,
        )

        assert isinstance(url, str), f"Expected string URL from S3, got {type(url)}"
        return url

    async def get_chunks(
        self,
        key: str,
        offset: int | None = None,
        length: int | None = None,
        recreate_client: bool = False,
    ) -> typing.AsyncIterator[bytes]:
        """
        Get chunks of data from a blob.

        Args:
            key: The key (path) of the blob in the bucket.
            offset: The offset in bytes to start reading from.
            length: The number of bytes to read.
            recreate_client: Whether to recreate the client for each chunk.

        Returns:
            An async iterator that yields chunks of data.

        Raises:
            BlobNotFoundError: If the blob does not exist.
        """
        prefixed_key = self._add_prefix(key)
        # Check if the blob exists first
        await self.get_blob_properties(prefixed_key)  # This will raise BlobNotFoundError if needed

        # Define an inner async generator function
        async def _chunks_iterator() -> typing.AsyncIterator[bytes]:
            s3_client = None
            s3_client_context: AsyncContextManager[S3Client] | None = None

            if recreate_client:
                # Create a fresh client
                s3_client_context = self.session.client("s3", **self._s3_client_kwargs(self.endpoint_url))
                s3_client = await s3_client_context.__aenter__()
            else:
                # Use the existing client
                s3_client = self._ensure_client()
            try:
                kwargs: dict[str, Any] = {}

                # Add range if specified
                if offset is not None and length is not None:
                    end = offset + length - 1  # S3 Range is inclusive
                    kwargs["Range"] = f"bytes={offset}-{end}"

                # Use handle_s3_operation with our get_object operation
                response = await self._handle_s3_operation(
                    prefixed_key, lambda: s3_client.get_object(Bucket=self.bucket_name, Key=prefixed_key, **kwargs)
                )

                stream = response["Body"]

                # Stream the chunks
                while True:
                    chunk = await stream.read(MAX_DOWNLOAD_CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

            finally:
                # If we created a new client, clean it up
                if s3_client_context is not None:
                    await s3_client_context.__aexit__(None, None, None)

        # Return the async generator
        return _chunks_iterator()

    async def _handle_s3_operation(self, key: str, operation: Callable[[], Awaitable[T]]) -> T:
        """
        Handle common S3 operation patterns including error handling.

        Args:
            key: The blob key (for error reporting)
            operation: Async function that performs the S3 operation

        Returns:
            The result of the operation

        Raises:
            BlobNotFoundError: If the blob doesn't exist
            StorageError: For other boto errors
        """
        try:
            return await operation()
        except botocore.exceptions.ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")
            # Handle 404 errors (NoSuchKey, 404, etc.)
            if error_code in ("404", "NoSuchKey") or "Not Found" in str(e):
                raise BlobNotFoundError(blob_name=key, storage_info=self.storage_info())
            # Re-raise any other boto errors
            raise
        except botocore.exceptions.BotoCoreError as e:
            # Handle other boto-specific errors
            raise StorageError(f"S3 operation failed: {str(e)}") from e

    async def get_blob(self, key: str) -> bytes:
        """
        Get a blob from S3 storage.

        Args:
            key: The key (path) of the blob in the bucket.

        Returns:
            The blob content as bytes.

        Raises:
            BlobNotFoundError: If the blob does not exist.
            AssertionError: If the response data is not bytes.
        """
        prefixed_key = self._add_prefix(key)
        s3_client = self._ensure_client()

        async def _get_operation() -> bytes:
            response = await s3_client.get_object(Bucket=self.bucket_name, Key=prefixed_key)
            data = await response["Body"].read()
            assert isinstance(data, bytes), f"Expected bytes from S3, got {type(data)}"
            return data

        return await self._handle_s3_operation(prefixed_key, _get_operation)

    async def list_blobs_with_prefix(self, prefix: str) -> list[BlobProperties]:
        """
        List all blobs with a given prefix.

        Args:
            prefix: The prefix to filter blobs by.

        Returns:
            A list of BlobProperties objects sorted by last_modified (oldest first).
        """
        prefixed_prefix = self._add_prefix(prefix)
        s3_client = self._ensure_client()

        if not prefixed_prefix:
            raise ValueError("Listing blobs without prefix is not supported. Filter first.")

        paginator = s3_client.get_paginator("list_objects_v2")
        blobs_list = []

        async for page in paginator.paginate(Bucket=self.bucket_name, Prefix=prefixed_prefix):
            if "Contents" in page:
                for obj in page["Contents"]:
                    blobs_list.append(
                        BlobProperties(
                            name=obj["Key"],
                            size=obj["Size"],
                            last_modified=obj["LastModified"],
                        )
                    )

        # Sort by oldest to newest
        return sorted(blobs_list, key=lambda blob: blob.last_modified, reverse=False)

    def get_blob_key_from_url(self, url: str) -> str:
        """Extract the blob key from an S3 URL."""
        parsed_url = url_parse.urlparse(url)

        # Handle custom endpoint URLs (like MinIO)
        if self.endpoint_url:
            endpoint_parsed = url_parse.urlparse(self.endpoint_url)
            if parsed_url.netloc == endpoint_parsed.netloc:
                # Path will be like /bucket_name/key
                if not parsed_url.path.startswith(f"/{self.bucket_name}/"):
                    raise ValueError(f"URL does not match this S3 storage bucket: {self.bucket_name}")
                return parsed_url.path[len(f"/{self.bucket_name}/") :]
        else:
            # Handle standard AWS S3 URLs
            # URL format: https://bucket-name.s3.region.amazonaws.com/key
            expected_host = f"{self.bucket_name}.s3.{self.region_name or 'us-east-1'}.amazonaws.com"
            if parsed_url.netloc != expected_host:
                raise ValueError(f"URL does not match this S3 storage: {expected_host}")
            return parsed_url.path.lstrip("/")

        raise ValueError(f"URL format not recognized for this S3 storage: {url}")

    async def delete_all_blobs(self, prefix: str | None = None) -> None:
        """
        This is potentially a long-running operation.
        """
        s3_client = self._ensure_client()
        paginator = s3_client.get_paginator("list_objects_v2")

        found = True
        while found:
            found = False
            if prefix:
                prefixed_prefix = self._add_prefix(prefix)
                pages = paginator.paginate(Bucket=self.bucket_name, Prefix=prefixed_prefix)
            else:
                pages = paginator.paginate(Bucket=self.bucket_name)
            batch = []
            async for page in pages:
                for obj in page.get("Contents", []):
                    batch.append(obj["Key"])
                    if len(batch) >= self._s3_max_delete_blobs:
                        found = True
                        await self.delete(batch)
                        batch.clear()
            if batch:
                await self.delete(batch)
                found = True

    async def delete(self, keys: list[str], raise_on_any_failure: bool = True) -> None:
        """
        Delete multiple blobs from S3 storage.

        Args:
            keys: A list of keys (paths) to delete.
            raise_on_any_failure: Whether to raise an exception if any of the deletions fail.
        """
        s3_client = self._ensure_client()

        if not keys:
            return

        # S3 batch delete requires a specific format
        objects = [{"Key": self._add_prefix(key)} for key in keys]

        try:
            response = await s3_client.delete_objects(
                Bucket=self.bucket_name,
                # SAFETY: objects are built as {"Key": ...} matching ObjectIdentifierTypeDef's required field
                Delete={"Objects": typing.cast(typing.Sequence[ObjectIdentifierTypeDef], objects)},
            )
        except Exception as e:
            if raise_on_any_failure:
                raise
            logger.error("Failed to delete some objects", error=str(e))
            return

        # `delete_objects` is a partial-failure API: it answers 200 while reporting per-key
        # failures in `Errors`, so the call succeeding says nothing about the keys. Without this
        # check `delete_all_blobs` silently loops over objects it never managed to delete.
        errors = response.get("Errors") or []
        if not errors:
            return
        summary = ", ".join(f"{e.get('Key')}: {e.get('Code')} {e.get('Message')}" for e in errors)
        if raise_on_any_failure:
            raise RuntimeError(f"Failed to delete {len(errors)} of {len(objects)} objects: {summary}")
        logger.error("Failed to delete some objects", failed=len(errors), total=len(objects), errors=summary)

    async def delete_existing(self, key: str) -> None:
        """
        Delete a blob if it exists.

        Args:
            key: The key (path) of the blob to delete.
        """
        prefixed_key = self._add_prefix(key)
        s3_client = self._ensure_client()

        try:
            # S3's delete_object is idempotent - it won't raise an error if the object doesn't exist
            await s3_client.delete_object(Bucket=self.bucket_name, Key=prefixed_key)
        except botocore.exceptions.ClientError as e:
            # Handle any unexpected S3 errors
            error_code = e.response.get("Error", {}).get("Code")
            error_msg = e.response.get("Error", {}).get("Message", str(e))

            logger.error(
                f"Error deleting S3 object: {error_code} - {error_msg}",
                key=prefixed_key,
                bucket=self.bucket_name,
            )

            # Only for unexpected errors - normally delete_object won't raise for non-existent objects
            raise RuntimeError(f"Failed to delete blob: {error_msg}") from e

    async def get_blob_properties(self, key: str) -> BlobProperties:
        """
        Get properties of a blob.

        Args:
            key: The key (path) of the blob in the bucket.

        Returns:
            A BlobProperties object.

        Raises:
            BlobNotFoundError: If the blob does not exist.
        """
        prefixed_key = self._add_prefix(key)
        s3_client = self._ensure_client()

        async def _get_properties_operation() -> BlobProperties:
            response = await s3_client.head_object(Bucket=self.bucket_name, Key=prefixed_key)
            return BlobProperties(
                name=prefixed_key,
                size=response["ContentLength"],
                last_modified=response["LastModified"],
            )

        return await self._handle_s3_operation(prefixed_key, _get_properties_operation)

    def storage_info(self) -> dict[str, str]:
        """
        Get information about the storage.

        Returns:
            A dictionary with information about the storage.
        """
        info = {
            # If endpoint_url is set, treat as s3-compatible (like MinIO)
            "provider": "s3-compatible" if self.endpoint_url else "s3",
            "bucket": self.bucket_name,
        }

        if self.region_name:
            info["region"] = self.region_name

        if self.endpoint_url:
            info["endpoint"] = self.endpoint_url

        return info

    def get_upload_headers(self) -> dict[str, str] | None:
        return None

    async def ensure_container_exists(self) -> None:
        """
        Ensures that the S3 bucket exists. Creates it if it doesn't.
        """
        s3_client = self._ensure_client()

        try:
            # Check if bucket exists by trying to get its location
            await s3_client.head_bucket(Bucket=self.bucket_name)
            logger.info(f"Bucket {self.bucket_name} already exists")
        except botocore.exceptions.ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")

            # 404 or NoSuchBucket means the bucket doesn't exist
            if error_code in ("404", "NoSuchBucket") or "Not Found" in str(e):
                try:
                    # Create the bucket
                    # Special case for us-east-1, don't specify LocationConstraint
                    if self.region_name and self.region_name != "us-east-1":
                        await s3_client.create_bucket(
                            Bucket=self.bucket_name,
                            CreateBucketConfiguration={
                                # SAFETY: region_name checked non-empty and != us-east-1 above; a valid S3 region
                                "LocationConstraint": typing.cast(BucketLocationConstraintType, self.region_name)
                            },
                        )
                    else:
                        # For us-east-1 or no region, don't specify LocationConstraint
                        await s3_client.create_bucket(Bucket=self.bucket_name)
                    logger.info(f"Bucket {self.bucket_name} created")
                except Exception as create_error:
                    logger.error(f"Error creating bucket: {create_error}")
                    raise
            else:
                # Some other error occurred when checking the bucket
                logger.error(f"Error checking bucket: {e}")
                raise
