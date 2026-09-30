import asyncio
import datetime
import threading
import typing
import urllib.parse as url_parse
import uuid
import weakref
from collections import defaultdict
from typing import Any, ClassVar, Optional

import structlog
import typing_extensions
from azure.core.exceptions import ResourceNotFoundError
from azure.core.pipeline.transport import AsyncHttpTransport
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.storage.blob import (
    BlobBlock,
    BlobSasPermissions,
    ContainerClient,
    ContentSettings,
    UserDelegationKey,
    generate_blob_sas,
)
from azure.storage.blob import BlobProperties as AzureBlobProperties
from azure.storage.blob.aio import BlobClient as AsyncBlobClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient
from azure.storage.blob.aio import ContainerClient as AsyncContainerClient
from azure.storage.blob.aio import ExponentialRetry
from typing_extensions import Self

from .base import BlobNotFoundError, BlobProperties, Bucket

logger = structlog.get_logger(__name__)


class ChunkUploadContext(typing.TypedDict):
    blob_client: typing_extensions.NotRequired[AsyncBlobClient]
    block_id_list: typing_extensions.NotRequired[list[BlobBlock]]
    content_type: typing_extensions.NotRequired[str]


class AzureBucket(Bucket):
    """Manages blobs in an Azure Blob Storage container."""

    _azure_max_delete_blobs = 256
    _cached_user_delegation_key: UserDelegationKey | None
    _cached_user_delegation_key_expires_on: datetime.datetime | None
    _user_delegation_key_lock: asyncio.Lock | None
    _shared_async_credentials: ClassVar[
        weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, Any]
    ] = weakref.WeakKeyDictionary()
    _shared_async_credential_factory: ClassVar[Any | None] = None
    _shared_async_credential_lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def _get_shared_async_credential(cls) -> Any:
        """Reuse a single async workload identity credential per event loop."""
        credential_factory = AsyncDefaultAzureCredential
        loop = asyncio.get_running_loop()
        with cls._shared_async_credential_lock:
            if cls._shared_async_credential_factory is not credential_factory:
                cls._shared_async_credentials = weakref.WeakKeyDictionary()
                cls._shared_async_credential_factory = credential_factory

            credential = cls._shared_async_credentials.get(loop)
            if credential is None:
                credential = credential_factory()
                cls._shared_async_credentials[loop] = credential

            return credential

    @classmethod
    async def close_shared_async_credential(cls, loop: asyncio.AbstractEventLoop | None = None) -> None:
        target_loop = loop or asyncio.get_running_loop()
        with cls._shared_async_credential_lock:
            credential = cls._shared_async_credentials.pop(target_loop, None)

        if credential is not None:
            await credential.close()

    @classmethod
    def _build_async_credential(cls) -> tuple[Any, bool]:
        try:
            return cls._get_shared_async_credential(), False
        except RuntimeError:
            return AsyncDefaultAzureCredential(), True

    async def _get_user_delegation_key(
        self,
        *,
        prefixed_key: str,
        now: datetime.datetime,
        sas_expiry_time: datetime.datetime,
    ) -> UserDelegationKey:
        cached_key = self._cached_user_delegation_key
        cached_key_expires_on = self._cached_user_delegation_key_expires_on
        if cached_key is not None and cached_key_expires_on is not None and cached_key_expires_on >= sas_expiry_time:
            return cached_key

        if self._user_delegation_key_lock is None:
            self._user_delegation_key_lock = asyncio.Lock()

        async with self._user_delegation_key_lock:
            cached_key = self._cached_user_delegation_key
            cached_key_expires_on = self._cached_user_delegation_key_expires_on
            if (
                cached_key is not None
                and cached_key_expires_on is not None
                and cached_key_expires_on >= sas_expiry_time
            ):
                return cached_key

            key_expiry_time = max(sas_expiry_time, now + datetime.timedelta(hours=1))
            async with self._get_new_blob_service_client(prefixed_key) as blob_service_client:
                user_delegation_key = await blob_service_client.get_user_delegation_key(
                    key_start_time=now,
                    key_expiry_time=key_expiry_time,
                )

            if user_delegation_key.signed_expiry:
                expires_on = datetime.datetime.fromisoformat(user_delegation_key.signed_expiry.replace("Z", "+00:00"))
                if expires_on.tzinfo is None:
                    expires_on = expires_on.replace(tzinfo=datetime.timezone.utc)
                else:
                    expires_on = expires_on.astimezone(datetime.timezone.utc)

                self._cached_user_delegation_key = user_delegation_key
                self._cached_user_delegation_key_expires_on = expires_on

            return user_delegation_key

    def _get_new_container_client(self) -> AsyncContainerClient:
        if self.use_workload_identity:
            assert self.account_url is not None
            return AsyncContainerClient(
                self.account_url,
                self.container_name,
                credential=self.credential,
                retry_policy=self.retry_policy,
                use_env_settings=self.use_env_settings,
                **self._get_client_kwargs(),
            )

        else:
            assert self.azure_connection_string is not None
            return AsyncContainerClient.from_connection_string(
                self.azure_connection_string,
                container_name=self.container_name,
                retry_policy=self.retry_policy,
                max_block_size=self.max_block_size,
                use_env_settings=self.use_env_settings,
                **self._get_client_kwargs(),
            )

    def _get_new_blob_client(self, prefixed_key: str) -> AsyncBlobClient:
        if self.use_workload_identity:
            assert self.account_url is not None
            return AsyncBlobClient(
                account_url=self.account_url,
                container_name=self.container_name,
                blob_name=prefixed_key,
                credential=self.credential,
                max_block_size=self.max_block_size,
                use_env_settings=self.use_env_settings,
                **self._get_client_kwargs(),
            )

        else:
            assert self.azure_connection_string is not None
            return AsyncBlobClient.from_connection_string(
                self.azure_connection_string,
                container_name=self.container_name,
                blob_name=prefixed_key,
                use_env_settings=self.use_env_settings,
                **self._get_client_kwargs(),
            )

    def _get_new_blob_service_client(self, prefixed_key: str) -> AsyncBlobServiceClient:
        if self.use_workload_identity:
            assert self.account_url is not None
            return AsyncBlobServiceClient(
                account_url=self.account_url,
                credential=self.credential,
                use_env_settings=self.use_env_settings,
                **self._get_client_kwargs(),
            )

        else:
            assert self.azure_connection_string is not None
            return AsyncBlobServiceClient.from_connection_string(
                self.azure_connection_string,
                blob_name=prefixed_key,
                use_env_settings=self.use_env_settings,
                **self._get_client_kwargs(),
            )

    def __init__(
        self,
        azure_connection_string: Optional[str],
        container_name: str,
        account_url: Optional[str] = None,
        prefix: Optional[str] = "",
        retry_policy: ExponentialRetry | None = None,
        use_workload_identity: bool = False,
        use_env_settings: bool = True,
        transport: AsyncHttpTransport | None = None,
        max_block_size: int = 64 * 1024 * 1024,  # 64MiB
        upload_max_concurrency: int = 1,
    ) -> None:
        self.azure_connection_string = azure_connection_string
        self.container_name = container_name
        self.account_url = account_url
        if self.account_url:
            self.account_name = url_parse.urlparse(self.account_url).netloc.split(".", 1)[0]
        elif self.azure_connection_string:
            self.account_name = ""
            for item in self.azure_connection_string.split(";"):
                if item.startswith("AccountName="):
                    self.account_name = item.removeprefix("AccountName=")
                    break
                if item.startswith("BlobEndpoint="):
                    endpoint = item.removeprefix("BlobEndpoint=")
                    self.account_name = url_parse.urlparse(endpoint).netloc.split(".", 1)[0]
                    break
            if not self.account_name:
                raise ValueError("Unable to determine Azure storage account name.")
        else:
            raise ValueError("Unable to determine Azure storage account name.")
        self.prefix = prefix
        if retry_policy is None:
            retry_policy = ExponentialRetry()
        self.retry_policy = retry_policy
        self.upload_chunk_contexts: defaultdict[str, ChunkUploadContext] = defaultdict(lambda: ChunkUploadContext())
        self.use_workload_identity = use_workload_identity
        self.credential: Any | None = None
        self._close_credential_on_exit = False
        if self.use_workload_identity:
            self.credential, self._close_credential_on_exit = self._build_async_credential()
        self.use_env_settings = use_env_settings
        self.transport = transport
        self.max_block_size = max_block_size
        self.upload_max_concurrency = upload_max_concurrency
        self.async_container_client: AsyncContainerClient | None = None
        self._cached_user_delegation_key: UserDelegationKey | None = None
        self._cached_user_delegation_key_expires_on: datetime.datetime | None = None
        self._user_delegation_key_lock: asyncio.Lock | None = None

    def _get_client_kwargs(self) -> dict[str, Any]:
        if self.transport is None:
            return {}

        return {"transport": self.transport}

    def _get_container_client(self) -> AsyncContainerClient:
        if self.async_container_client is None:
            self.async_container_client = self._get_new_container_client()
        return self.async_container_client

    def _add_prefix(self, key: str) -> str:
        """Add the prefix to the key."""
        if self.prefix and not key.startswith(self.prefix):
            return f"{self.prefix}{key}"
        return key

    async def __aenter__(self) -> Self:
        await self._get_container_client().__aenter__()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        # Workload identity credentials are shared per event loop to keep token
        # caches warm without crossing event-loop boundaries.
        if self.async_container_client is not None:
            await self.async_container_client.__aexit__(exc_type, exc_val, exc_tb)
            self.async_container_client = None
        if self._close_credential_on_exit and self.credential is not None:
            await self.credential.close()

    async def upload_blob(
        self,
        key: str,
        content: bytes | typing.BinaryIO | typing.AsyncIterable[bytes],
        overwrite: bool = True,
        content_type: str | None = None,
        **upload_kwargs: Any,
    ) -> str:
        """
        Upload a blob to Azure storage.

        Args:
            key: The key (path) of the blob in the container.
            content: The content to upload (either bytes or a file-like object).
            overwrite: Whether to overwrite if the blob already exists (default: True).
            upload_kwargs: Additional args arguments for the Azure upload_blob operation.

        Returns:
            The URL of the uploaded blob.
        """
        prefixed_key = self._add_prefix(key)
        container_client = self._get_container_client()
        # Set overwrite parameter
        upload_kwargs.setdefault("overwrite", overwrite)
        if content_type:
            # Azure carries the MIME type in `content_settings`, not a `content_type` kwarg -- the
            # latter is swallowed by `**kwargs` and the blob comes back as
            # `application/octet-stream`. The chunked path below already does it this way.
            upload_kwargs.setdefault("content_settings", ContentSettings(content_type=content_type))
        if self.upload_max_concurrency > 0:
            upload_kwargs.setdefault("max_concurrency", self.upload_max_concurrency)

        blob = await container_client.upload_blob(
            name=prefixed_key,
            data=content,
            **upload_kwargs,
        )
        return blob.url

    async def upload_chunk(
        self,
        key: str,
        content: bytes,
        **upload_kwargs: Any,
    ) -> None:
        prefixed_key = self._add_prefix(key)
        upload_chunk_context = self.upload_chunk_contexts[prefixed_key]
        if "blob_client" not in upload_chunk_context:
            upload_chunk_context["blob_client"] = self._get_new_blob_client(prefixed_key)
        if "block_id_list" not in upload_chunk_context:
            upload_chunk_context["block_id_list"] = []
        content_type = upload_kwargs.get("content_type")
        if isinstance(content_type, str) and "content_type" not in upload_chunk_context:
            upload_chunk_context["content_type"] = content_type
        blob_client = upload_chunk_context["blob_client"]
        block_id_list = upload_chunk_context["block_id_list"]
        block_id = uuid.uuid4().hex
        block_id_list.append(BlobBlock(block_id=block_id))
        await blob_client.stage_block(
            block_id=block_id,
            data=content,
        )

    async def finish_upload_chunk(self, key: str) -> None:
        prefixed_key = self._add_prefix(key)
        upload_chunk_context = self.upload_chunk_contexts[prefixed_key]
        if "blob_client" in upload_chunk_context:
            blob_client = upload_chunk_context["blob_client"]
            block_id_list = upload_chunk_context.get("block_id_list", [])
            commit_kwargs: dict[str, Any] = {}
            content_type = upload_chunk_context.get("content_type")
            if content_type:
                commit_kwargs["content_settings"] = ContentSettings(content_type=content_type)
            await blob_client.commit_block_list(block_id_list, **commit_kwargs)
            await blob_client.close()
        else:
            logger.warning(
                "AzureBucket.finish_upload_chunk called with no blob_client in upload_chunk_context.",
            )
        self.upload_chunk_contexts.pop(prefixed_key)

    async def generate_signed_url(
        self,
        key: str,
        read_permission: bool,
        write_permission: bool,
        expiration_time_seconds: int,
        filename: str | None = None,
    ) -> str:
        prefixed_key = self._add_prefix(key)
        sas_permissions = BlobSasPermissions(
            read=read_permission,
            write=write_permission,
        )
        now = datetime.datetime.now(datetime.timezone.utc)
        expiry_time = now + datetime.timedelta(seconds=expiration_time_seconds)

        content_disposition = f"attachment; filename={url_parse.quote(filename)}" if filename else None

        account_key: str | None = None
        user_delegation_key: UserDelegationKey | None = None
        if self.use_workload_identity:
            user_delegation_key = await self._get_user_delegation_key(
                prefixed_key=prefixed_key,
                now=now,
                sas_expiry_time=expiry_time,
            )
        else:
            account_key = self._get_container_client().credential.account_key

        container_client = self._get_container_client()

        # generate_blob_sas signs over the *decoded* blob name; Azure decodes the request path once
        # before validating, so the signature must be computed over the raw key (not URL-encoded).
        sas = generate_blob_sas(
            # SAFETY: container client is always constructed with an account name, so account_name is set
            account_name=typing.cast(str, container_client.account_name),
            container_name=container_client.container_name,
            account_key=account_key,
            user_delegation_key=user_delegation_key,
            blob_name=prefixed_key,
            permission=sas_permissions,
            expiry=expiry_time,
            content_disposition=content_disposition,
        )

        # ...but the URL path must be percent-encoded, otherwise a key containing URL-unsafe
        # characters (e.g. a SharePoint "spo%3Afile%3A..." blob name, or a space) yields a path that
        # Azure decodes to the wrong blob name -> the fetch 404s / the signature mismatches (403).
        return str(container_client.url) + "/" + url_parse.quote(prefixed_key, safe="/") + "?" + sas

    def get_blob_key_from_url(self, url: str) -> str:
        """The blob key is everything that comes after the container name"""
        parsed_url = url_parse.urlparse(url)

        if (
            parsed_url.scheme != "https"
            or parsed_url.netloc != f"{self.account_name}.blob.core.windows.net"
            or not parsed_url.path.startswith(f"/{self.container_name}/")
        ):
            raise ValueError("URL does not match this Azure storage.")
        return parsed_url.path[len(f"/{self.container_name}/") :]

    async def get_blob_properties(self, key: str) -> BlobProperties:
        prefixed_key = self._add_prefix(key)
        blob_client = self._get_container_client().get_blob_client(prefixed_key)
        try:
            return self.format_blob_properties(await blob_client.get_blob_properties())
        except ResourceNotFoundError:
            raise BlobNotFoundError(blob_name=prefixed_key, storage_info=self.storage_info())

    async def iter_blob_properties(self, prefix: str | None = None) -> typing.AsyncIterator[BlobProperties]:
        """Yield blob metadata for the container without materializing the full listing."""
        prefixed_prefix = self._add_prefix(prefix) if prefix is not None else None

        async for blob in self._get_container_client().list_blobs(name_starts_with=prefixed_prefix):
            yield self.format_blob_properties(blob)

    async def list_blobs_with_prefix(self, prefix: str) -> list[BlobProperties]:
        """
        Lists all blobs in a container that have a specified prefix, sorted by oldest to newest.

        :param prefix: The prefix to filter blobs by.
        :return: A list of blob names that match the given prefix.
        """
        prefixed_prefix = self._add_prefix(prefix)
        if prefixed_prefix is None:
            raise ValueError("Listing blobs without prefix is not supported. Filter first.")

        blobs_list = [blob async for blob in self.iter_blob_properties(prefix)]
        # sort by oldest to newest
        return sorted(blobs_list, key=lambda blob: blob.last_modified, reverse=False)

    async def get_blob(self, key: str) -> bytes:
        prefixed_key = self._add_prefix(key)
        blob_client = self._get_container_client().get_blob_client(prefixed_key)
        try:
            blob_download = await blob_client.download_blob()
            # SAFETY: download_blob() with no encoding returns raw bytes from readall()
            return typing.cast(bytes, await blob_download.readall())
        except ResourceNotFoundError:
            raise BlobNotFoundError(prefixed_key, self.storage_info())

    async def get_chunks(
        self, key: str, offset: int | None = None, length: int | None = None, recreate_client: bool = False
    ) -> typing.AsyncIterator[bytes]:
        prefixed_key = self._add_prefix(key)
        blob_client = self._get_container_client().get_blob_client(prefixed_key)
        if not await blob_client.exists():
            raise BlobNotFoundError(prefixed_key, self.storage_info())

        async def _chunks_iterator() -> typing.AsyncIterator[bytes]:
            if recreate_client:
                async with self._get_new_blob_client(prefixed_key) as new_blob_client:
                    blob_download = await new_blob_client.download_blob(offset=offset, length=length)
                    async for chunk in blob_download.chunks():
                        yield chunk
            else:
                blob_download = await blob_client.download_blob(offset=offset, length=length)
                async for chunk in blob_download.chunks():
                    yield chunk

        return _chunks_iterator()

    async def delete_all_blobs(self, prefix: str | None = None) -> None:
        """
        This is potentially a long-running operation.
        """
        prefixed_prefix = self._add_prefix(prefix) if prefix else None
        found = True
        # do it multiple times to handle failures
        while found:
            found = False
            blobs_to_delete = self._get_container_client().list_blobs(
                name_starts_with=prefixed_prefix, results_per_page=1000
            )
            batch = []
            async for blob in blobs_to_delete:
                batch.append(blob.name)
                if len(batch) == self._azure_max_delete_blobs:
                    found = True
                    await self.delete(batch, raise_on_any_failure=False)
                    batch.clear()
            # delete the remaining blobs
            if batch:
                await self.delete(batch)
                found = True

    async def delete(self, keys: list[str], raise_on_any_failure: bool = True) -> None:
        prefixed_keys = [self._add_prefix(key) for key in keys]
        await self._get_container_client().delete_blobs(
            *prefixed_keys,
            raise_on_any_failure=raise_on_any_failure,
        )

    async def delete_existing(self, key: str) -> None:
        prefixed_key = self._add_prefix(key)
        blob_client = self._get_container_client().get_blob_client(prefixed_key)
        exist = await blob_client.exists()
        if exist:
            await blob_client.delete_blob()

    @staticmethod
    def format_blob_properties(blob_properties: AzureBlobProperties) -> BlobProperties:
        return BlobProperties(
            size=blob_properties.size,
            name=blob_properties.name,
            last_modified=blob_properties.last_modified,
        )

    def storage_info(self) -> dict[str, str]:
        if self.use_workload_identity:
            assert self.account_url is not None
            with DefaultAzureCredential() as credentials:
                with ContainerClient(
                    self.account_url,
                    self.container_name,
                    credential=credentials,
                    retry_policy=self.retry_policy,
                    use_env_settings=self.use_env_settings,
                ) as container_client:
                    return {
                        "provider": "azure",
                        "account_name": container_client.account_name,
                        "container": container_client.container_name,
                    }
        else:
            assert self.azure_connection_string is not None
            with ContainerClient.from_connection_string(
                self.azure_connection_string,
                container_name=self.container_name,
                use_env_settings=self.use_env_settings,
            ) as container_client:
                return {
                    "provider": "azure",
                    "account_name": container_client.account_name,
                    "container": container_client.container_name,
                }

    def get_upload_headers(self) -> dict[str, str] | None:
        return {"x-ms-blob-type": "BlockBlob"}

    async def ensure_container_exists(self) -> None:
        """
        Ensures that the container exists. Creates it if it doesn't.
        """
        container_client = self._get_container_client()
        exists = await container_client.exists()
        if not exists:
            try:
                await container_client.create_container()
                logger.info(f"Container {self.container_name} created")
            except Exception as e:
                logger.error(f"Error creating container: {e}")
                raise
