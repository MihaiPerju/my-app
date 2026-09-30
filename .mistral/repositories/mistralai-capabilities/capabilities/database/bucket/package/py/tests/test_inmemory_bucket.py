"""Contract tests for the in-memory Bucket backend.

`InMemoryBucket` is not a test double that only tests itself: it is the backend a generated
app runs against whenever no object store is configured, and it is the reference implementation of
the `Bucket` protocol the S3/GCS/Azure backends also satisfy. So the behaviour pinned here is
the behaviour every backend owes its callers — round-tripping the three accepted content shapes,
raising `BlobNotFoundError` rather than returning empty, and chunking without dropping or
reordering bytes.

The network-backed backends are deliberately not exercised; they need live credentials and belong
in an integration tier, not in a suite that must run inside every generated app.
"""

import pytest
from mistralai_capabilities.bucket import (
    BlobNotFoundError,
    BlobProperties,
    InMemoryBucket,
)


async def test_bytes_round_trip() -> None:
    storage = InMemoryBucket(container_url="https://example.test/c")

    url = await storage.upload_blob("a.txt", b"hello")

    assert await storage.get_blob("a.txt") == b"hello"
    # The returned URL is the caller's handle to the object; it must address the key it stored.
    assert url == "https://example.test/c/a.txt"


async def test_accepts_a_file_like_object() -> None:
    import io

    storage = InMemoryBucket()

    await storage.upload_blob("f.bin", io.BytesIO(b"from-file"))

    assert await storage.get_blob("f.bin") == b"from-file"


async def test_accepts_an_async_iterable_and_encodes_str_chunks() -> None:
    # The streaming upload path is the one that concatenates chunks by hand, so it is where a
    # dropped or misordered chunk would show up. `str` chunks are encoded rather than rejected.
    async def chunks():
        yield b"ab"
        yield "cd"
        yield b"ef"

    storage = InMemoryBucket()

    await storage.upload_blob("s.bin", chunks())

    assert await storage.get_blob("s.bin") == b"abcdef"


async def test_overwrite_false_is_rejected_loudly() -> None:
    # The backend cannot honour it, so it must refuse rather than silently overwrite — a caller
    # guarding against clobbering data would otherwise be given the opposite of what it asked for.
    storage = InMemoryBucket()
    await storage.upload_blob("k", b"first")

    with pytest.raises(NotImplementedError):
        await storage.upload_blob("k", b"second", overwrite=False)

    assert await storage.get_blob("k") == b"first"


async def test_missing_blob_raises_rather_than_returning_empty() -> None:
    storage = InMemoryBucket()

    with pytest.raises(BlobNotFoundError):
        await storage.get_blob("nope")


async def test_get_chunks_defers_its_not_found_until_iteration() -> None:
    """`get_chunks` is an async function returning a generator, so the raise is deferred.

    Awaiting it for a missing key yields an iterator and does NOT raise; the error only surfaces on
    the first `__anext__`. A caller that awaits inside a `try` and iterates outside it will miss the
    exception entirely, so pin the actual shape rather than the intuitive one.
    """
    storage = InMemoryBucket()

    iterator = await storage.get_chunks("nope")

    with pytest.raises(BlobNotFoundError):
        await anext(iterator)


@pytest.mark.parametrize("chunk_size", [1, 3, 5, 100])
async def test_chunking_preserves_content_at_every_boundary(chunk_size: int) -> None:
    # Sizes that divide the payload exactly, leave a remainder, and exceed it whole: the three ways
    # an off-by-one in the slice window shows up.
    storage = InMemoryBucket()
    payload = b"0123456789"
    storage.add_blob("p.bin", payload, chunk_size=chunk_size)

    received = [chunk async for chunk in await storage.get_chunks("p.bin")]

    assert b"".join(received) == payload
    assert all(len(chunk) <= chunk_size for chunk in received)
    assert all(received), "an empty chunk means the slice window overran the payload"


async def test_list_blobs_with_prefix_selects_only_matching_keys() -> None:
    storage = InMemoryBucket()
    await storage.upload_blob("docs/a", b"a")
    await storage.upload_blob("docs/b", b"bb")
    await storage.upload_blob("other/c", b"ccc")

    listed = await storage.list_blobs_with_prefix("docs/")

    assert all(isinstance(entry, BlobProperties) for entry in listed)
    assert {(entry.name, entry.size) for entry in listed} == {("docs/a", 1), ("docs/b", 2)}


async def test_delete_existing_is_strict_and_bulk_delete_is_tolerant() -> None:
    # The two deletes differ on purpose: `delete_existing` is the one a caller uses when absence is
    # a bug, `delete` is the idempotent bulk sweep. Collapsing them would break one caller silently.
    storage = InMemoryBucket()
    await storage.upload_blob("present", b"x")

    await storage.delete_existing("present")
    with pytest.raises(BlobNotFoundError):
        await storage.delete_existing("present")

    await storage.delete(["absent", "also-absent"])


async def test_async_context_manager_tracks_open_state() -> None:
    storage = InMemoryBucket()
    assert storage.is_open is False

    async with storage as entered:
        assert entered is storage
        assert storage.is_open is True

    assert storage.is_open is False
