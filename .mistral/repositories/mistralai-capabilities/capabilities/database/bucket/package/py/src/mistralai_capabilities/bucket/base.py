import datetime
import typing
from typing import TYPE_CHECKING, Any

from typing_extensions import NamedTuple, NotRequired, Self

if TYPE_CHECKING:
    from azure.core.pipeline.transport import AsyncHttpTransport
    from azure.storage.blob.aio import ExponentialRetry


class BlobProperties(NamedTuple):
    name: str
    size: int
    last_modified: datetime.datetime


class CloudSpecificKwargs(typing.TypedDict):
    transport: NotRequired["AsyncHttpTransport"]  # for Azure
    container_name: NotRequired[str]  # for Azure
    azure_connection_string: NotRequired[str]  # for Azure
    azure_use_workload_identity: NotRequired[bool]  # for Azure
    azure_use_env_settings: NotRequired[bool]  # for Azure
    azure_upload_max_concurrency: NotRequired[int]  # for Azure
    account_url: NotRequired[str]  # for Azure
    retry_policy: NotRequired["ExponentialRetry"]  # for Azure
    bucket_id: NotRequired[str]  # for GCP
    gcs_service_account_email: NotRequired[str]  # for GCP
    bucket_name: NotRequired[str]  # for S3
    region_name: NotRequired[str]  # for S3
    endpoint_url: NotRequired[str]  # for S3 (custom endpoints like MinIO)
    public_endpoint_url: NotRequired[str]  # for split-horizon minio
    prefix: NotRequired[str]  # for all
    aws_access_key_id: NotRequired[str]  # for S3
    aws_secret_access_key: NotRequired[str]  # for S3
    aws_session_token: NotRequired[str]  # for S3
    signature_version: NotRequired[str]  # for S3
    gcs_storage: NotRequired[
        Any
    ]  # for GCP ## TODO(jm): replace with proper type, annoying because gcs is not always installed


class BlobNotFoundError(RuntimeError):
    def __init__(self, blob_name: str, storage_info: dict[str, str]):
        message = f"Blob {blob_name} was not found in the storage: {storage_info}"
        super().__init__(message)


class Bucket(typing.Protocol):
    async def __aenter__(self) -> Self:
        ...

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        ...

    async def upload_blob(
        self,
        key: str,
        content: bytes | typing.BinaryIO | typing.AsyncIterable[bytes],
        overwrite: bool = True,
        **upload_kwargs: typing.Any,
    ) -> str:
        ...

    async def upload_chunk(
        self,
        key: str,
        content: bytes,
        **upload_kwargs: typing.Any,
    ) -> None:
        ...

    async def finish_upload_chunk(self, key: str) -> None:
        ...

    async def generate_signed_url(
        self,
        key: str,
        read_permission: bool,
        write_permission: bool,
        expiration_time_seconds: int,
        filename: str | None = None,
    ) -> str:
        ...

    def get_blob_key_from_url(self, url: str) -> str:
        ...

    async def get_chunks(
        self, key: str, offset: int | None = None, length: int | None = None, recreate_client: bool = False
    ) -> typing.AsyncIterator[bytes]:
        ...

    async def get_blob(self, key: str) -> bytes:
        ...

    async def list_blobs_with_prefix(self, prefix: str) -> list[BlobProperties]:
        ...

    async def delete_all_blobs(self, prefix: str | None = None) -> None:
        ...

    async def delete(self, keys: list[str], raise_on_any_failure: bool = True) -> None:
        ...

    async def delete_existing(self, key: str) -> None:
        ...

    async def get_blob_properties(self, key: str) -> BlobProperties:
        ...

    async def has_blob(self, key: str) -> bool:
        try:
            return await self.get_blob_properties(key) is not None
        except BlobNotFoundError:
            return False

    def storage_info(self) -> dict[str, str]:
        ...

    def get_upload_headers(self) -> dict[str, str] | None:
        ...

    async def ensure_container_exists(self) -> None:
        ...
