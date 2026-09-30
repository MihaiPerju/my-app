"""Object-storage (bucket) library for the Mistral Apps bucket capability."""

from enum import Enum

import typing_extensions

from .base import BlobNotFoundError, BlobProperties, Bucket, CloudSpecificKwargs
from .inmemory import InMemoryBucket

try:
    from .az import AzureBucket

    bucket_azure_installed = True
except ImportError:
    bucket_azure_installed = False


try:
    from .gcs import GCSBucket

    bucket_gcs_installed = True
except ImportError:
    bucket_gcs_installed = False

try:
    from .s3 import S3Bucket

    bucket_s3_installed = True
except ImportError:
    bucket_s3_installed = False


# `S3Bucket` is listed because S3 is a base dependency, so the guarded import above always
# succeeds and the name is always bound. `GCSBucket` / `AzureBucket` are deliberately
# absent: they exist only under the `[gcs]` / `[azure]` extras, and a name in `__all__` that
# `import *` cannot resolve is a broken export. Reach them through `bucket_factory`, which
# raises a directed ImportError, or import them explicitly and handle the ImportError yourself.
__all__ = [
    "BlobNotFoundError",
    "BlobProperties",
    "Bucket",
    "CloudSpecificKwargs",
    "InMemoryBucket",
    "S3Bucket",
    "StorageProvider",
    "bucket_factory",
]


class StorageProvider(str, Enum):
    AZURE = "azure"
    GCS = "gcs"
    S3 = "s3"


def bucket_factory(
    storage_provider: StorageProvider,
    **cloud_specific_kwargs: typing_extensions.Unpack[CloudSpecificKwargs],
) -> Bucket:
    """
    Factory to create a Bucket instance.
    Args:
        cloud_specific_kwargs:
            - for Azure: container_name and azure_connection_string (optional use_workload_identity),
              optional transport to pass a custom Azure HTTP transport, and optional
              azure_use_env_settings to control proxy env usage
            - for GCS: bucket_id, service_acount_email
            - for S3: bucket_name (and optionally endpoint_url, region_name,
                      aws_access_key_id, aws_secret_access_key)
                      When endpoint_url is provided, S3-compatible storage is used (e.g., MinIO)
    """
    if storage_provider == StorageProvider.AZURE:
        if not bucket_azure_installed:
            raise ImportError("Azure bucket dependencies are not installed.")
        container_name = cloud_specific_kwargs.get("container_name")
        if not container_name:
            raise ValueError("container_name is required for Azure Blob Storage")
        use_workload_identity = cloud_specific_kwargs.get("azure_use_workload_identity", False)
        if not use_workload_identity and not cloud_specific_kwargs.get("azure_connection_string"):
            raise ValueError("azure_connection_string is required for Azure Blob Storage")
        if use_workload_identity and not cloud_specific_kwargs.get("account_url"):
            raise ValueError("account_url is required for Azure Blob Storage when using workload identity")
        return AzureBucket(
            azure_connection_string=cloud_specific_kwargs.get("azure_connection_string"),
            container_name=cloud_specific_kwargs["container_name"],
            retry_policy=cloud_specific_kwargs.get("retry_policy"),
            prefix=cloud_specific_kwargs.get("prefix"),
            account_url=cloud_specific_kwargs.get("account_url"),
            use_workload_identity=cloud_specific_kwargs.get("azure_use_workload_identity", False),
            use_env_settings=cloud_specific_kwargs.get("azure_use_env_settings", True),
            transport=cloud_specific_kwargs.get("transport"),
            upload_max_concurrency=cloud_specific_kwargs.get("azure_upload_max_concurrency", 1),
        )
    if storage_provider == StorageProvider.GCS:
        if not bucket_gcs_installed:
            raise ImportError("GCS bucket dependencies are not installed.")
        if not cloud_specific_kwargs.get("bucket_id"):
            raise ValueError("bucket_id is required for GCSBucket.")
        return GCSBucket(
            bucket_id=cloud_specific_kwargs["bucket_id"],
            storage=cloud_specific_kwargs.get("gcs_storage"),
            prefix=cloud_specific_kwargs.get("prefix"),
            service_account_email=cloud_specific_kwargs.get("gcs_service_account_email"),
        )
    if storage_provider == StorageProvider.S3:
        if not bucket_s3_installed:
            raise ImportError("S3 bucket dependencies are not installed.")
        if not cloud_specific_kwargs.get("bucket_name"):
            raise ValueError("bucket_name is required for S3Bucket.")
        return S3Bucket(
            bucket_name=cloud_specific_kwargs["bucket_name"],
            region_name=cloud_specific_kwargs.get("region_name"),
            endpoint_url=cloud_specific_kwargs.get("endpoint_url"),
            public_endpoint_url=cloud_specific_kwargs.get("public_endpoint_url"),
            aws_access_key_id=cloud_specific_kwargs.get("aws_access_key_id"),
            aws_secret_access_key=cloud_specific_kwargs.get("aws_secret_access_key"),
            aws_session_token=cloud_specific_kwargs.get("aws_session_token"),
            prefix=cloud_specific_kwargs.get("prefix"),
            signature_version=cloud_specific_kwargs.get("signature_version"),
        )

    raise NotImplementedError(f"{storage_provider} is not supported yet")
