import datetime
import typing
from typing import Any

from .base import BlobNotFoundError, BlobProperties, Bucket


class InMemoryBucket(Bucket):
    def __init__(self, chunk_size: int = 1024 * 1024, container_url: str = "") -> None:
        self.blobs: dict[str, bytes] = {}
        self.chunk_sizes: dict[str, int] = {}
        self.is_open = False
        self.default_chunk_size = chunk_size
        self.context_manager_used = False
        self.upload_calls: list[tuple[str, int]] = []
        self.get_chunks_calls: list[str] = []
        self.delete_calls: list[str] = []
        self.container_url = container_url

    async def __aenter__(self) -> "InMemoryBucket":
        self.is_open = True
        self.context_manager_used = True
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.is_open = False

    def add_blob(self, key: str, content: bytes, chunk_size: int | None = None) -> None:
        self.blobs[key] = content
        if chunk_size:
            self.chunk_sizes[key] = chunk_size

    async def upload_blob(
        self,
        key: str,
        content: bytes | typing.BinaryIO | typing.AsyncIterable[bytes],
        overwrite: bool = True,
        **upload_kwargs: typing.Any,
    ) -> str:
        if not overwrite:
            raise NotImplementedError("InMemoryBucket only support overwrite=True")
        if isinstance(content, typing.AsyncIterable):
            content_bytes = b""
            async for chunk in content:
                if isinstance(chunk, str):
                    content_bytes += chunk.encode("utf-8")
                else:
                    content_bytes += chunk
        elif hasattr(content, "read"):
            # file-like obj handling
            content_bytes = content.read()
            if isinstance(content_bytes, str):
                content_bytes = content_bytes.encode("utf-8")
        else:
            content_bytes = content

        self.blobs[key] = content_bytes
        self.upload_calls.append((key, len(content_bytes)))
        return f"{self.container_url}/{key}"

    async def get_chunks(
        self, key: str, offset: int | None = None, length: int | None = None, recreate_client: bool = False
    ) -> typing.AsyncIterator[bytes]:
        async def _chunks_iterator() -> typing.AsyncIterator[bytes]:
            if key not in self.blobs:
                raise BlobNotFoundError(blob_name=key, storage_info=self.storage_info())

            self.get_chunks_calls.append(key)
            content = self.blobs[key]
            total = len(content)
            chunk_size = self.chunk_sizes.get(key, self.default_chunk_size)

            for i in range(0, total, chunk_size):
                yield content[i : i + chunk_size]

        return _chunks_iterator()

    async def get_blob(self, key: str) -> bytes:
        if key not in self.blobs:
            raise BlobNotFoundError(blob_name=key, storage_info=self.storage_info())
        return self.blobs[key]

    async def delete_existing(self, key: str) -> None:
        if key in self.blobs:
            del self.blobs[key]
            self.delete_calls.append(key)
        else:
            raise BlobNotFoundError(blob_name=key, storage_info=self.storage_info())

    async def delete(self, keys: list[str], raise_on_any_failure: bool = True) -> None:
        for key in keys:
            if key not in self.blobs:
                continue
            del self.blobs[key]
            self.delete_calls.append(key)

    async def list_blobs_with_prefix(self, prefix: str) -> list[BlobProperties]:
        blob_list = []
        for key in self.blobs.keys():
            if key.startswith(prefix):
                blob_list.append(
                    BlobProperties(
                        name=key,
                        size=len(self.blobs[key]),
                        last_modified=datetime.datetime.now(),
                    )
                )
        return blob_list

    def storage_info(self) -> dict[str, str]:
        return {"type": "mock", "blob_count": str(len(self.blobs))}

    def get_upload_headers(self) -> dict[str, str] | None:
        return None

    async def generate_signed_url(
        self,
        key: str,
        read_permission: bool,
        write_permission: bool,
        expiration_time_seconds: int,
        filename: str | None = None,
    ) -> str:
        return f"{self.container_url}/{key}?signed=true"
