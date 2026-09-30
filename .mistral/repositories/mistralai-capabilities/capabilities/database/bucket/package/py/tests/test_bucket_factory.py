"""Argument-validation and construction tests for ``bucket_factory``.

The factory is the one place a provider plus a bag of kwargs becomes a concrete backend, so it owns
two contracts: reject a call that omits a provider's required key (rather than build a
half-configured client that only fails later against live storage), and wire the accepted keys onto
the backend it returns. Only the S3 path is exercised -- it is the base backend a generated app
always installs; GCS/Azure live behind optional extras this suite does not require.
"""

import pytest
from mistralai_capabilities.bucket import StorageProvider, bucket_factory


def test_s3_requires_a_bucket_name() -> None:
    pytest.importorskip("aioboto3")  # base dep; present in a generated app, absent in a bare checkout

    with pytest.raises(ValueError, match="bucket_name"):
        bucket_factory(StorageProvider.S3)


def test_s3_backend_is_wired_from_its_kwargs() -> None:
    pytest.importorskip("aioboto3")
    from mistralai_capabilities.bucket import S3Bucket

    storage = bucket_factory(
        StorageProvider.S3,
        bucket_name="documents",
        region_name="us-east-1",
        endpoint_url="http://localhost:9000",
        aws_access_key_id="key",
        aws_secret_access_key="secret",
        prefix="dau/",
    )

    assert isinstance(storage, S3Bucket)
    assert storage.bucket_name == "documents"
    assert storage.endpoint_url == "http://localhost:9000"
    assert storage.region_name == "us-east-1"
    assert storage.prefix == "dau/"
    # Credentials must be preserved too, or dropping either from the factory would slip past a
    # wiring test that only checked the non-secret fields.
    assert storage.aws_access_key_id == "key"
    assert storage.aws_secret_access_key == "secret"
