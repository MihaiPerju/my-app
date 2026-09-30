---
name: capability-bucket
description: The app's object-storage library — the async `Bucket` protocol (`mistralai_capabilities.bucket`) with an S3-compatible backend (base), GCS/Azure (extras), and an in-memory test double — that the ingestion consumers import. Use when reading or writing blobs through `Bucket`, when constructing a backend with `bucket_factory`, when wiring the `INGESTION_S3_*` settings, or when adding a storage backend. The local RustFS dev server ships from the `docker-compose-bucket` overlay, not here.
---

# Bucket

The object-storage client library: one async `Bucket` protocol over S3 (base), GCS/Azure (extras), and an in-memory double, imported as `mistralai_capabilities.bucket`. Owns the **client library only** — no routes, no Helm subchart, no env reader. Consumers `document-annotation-ui` (document transport) and `search` (ingested corpus) import it; the local RustFS dev server ships from the `docker-compose-bucket` overlay and the typed `INGESTION_S3_*` reader lives in the consumer.

## Where things live

Published as `mistralai-capabilities-database-bucket`; wired as a path-source package, so `template/` vendors only this skill. The TS package `@mistralai-capabilities/database-bucket` is a marker type — no runtime surface.

| Module | What |
| --- | --- |
| `mistralai_capabilities.bucket` (`__init__`) | Public surface + `bucket_factory`, `StorageProvider` enum. Exports `Bucket`, `BlobProperties`, `BlobNotFoundError`, `CloudSpecificKwargs`, `S3Bucket`, `InMemoryBucket`. |
| `.base` | `Bucket` `typing.Protocol` (upload/get/list/delete, chunked upload, signed URLs), `BlobProperties`, `BlobNotFoundError`, `CloudSpecificKwargs` TypedDict (all backends' kwargs). |
| `.s3` | `S3Bucket` — base S3-compatible backend (AWS S3 or self-hosted MinIO/RustFS via `endpoint_url`), on `aioboto3`/`botocore`. |
| `.gcs` / `.az` | `GCSBucket` / `AzureBucket` — optional, need the `[gcs]` / `[azure]` extra. |
| `.inmemory` | `InMemoryBucket` — in-process test double. |

## Extend

- **Construct** via `bucket_factory(StorageProvider, **CloudSpecificKwargs) -> Bucket` (the seam). It validates per-provider kwargs — S3: `bucket_name`; GCS: `bucket_id`; Azure: `container_name` + (`azure_connection_string` or `azure_use_workload_identity`+`account_url`) — and forwards `aws_session_token`. One TypedDict covers all providers; only the selected provider's keys apply.
- **New backend:** add a `.<name>` module whose class conforms to the `Bucket` Protocol by shape (no base class); a missing blob MUST raise `BlobNotFoundError`. Optional backends stay OUT of `__all__`, install under an extra, and are reached via `bucket_factory` (directed `ImportError` when the extra is missing). `S3Bucket` stays in `__all__` (import always succeeds).
- **New ingestion setting:** declare it in the consumer's `envVars` — `env/ingestion.py` (`search`) or `env/document_annotation_ui.py` (document-annotation-ui) — not here.
- **S3-compatible endpoint:** `S3Bucket(endpoint_url=...)` targets MinIO/RustFS (path-style default). Pass `None` (not `""`) to fall through to the default AWS chain (prod: IRSA/instance-profile). `public_endpoint_url` overrides for signed URLs; `signature_version` = `s3`/`s3v4`.

## Gotchas

- `upload_blob` accepts bytes, a file object, or an async iterable; an empty async iterable stores an empty object, not an error.
- RustFS dev server + one-shot `bucket-setup` seed job ship from `docker-compose-bucket` (`deploy/compose/compose.bucket.yaml`); selecting bucket sets `INGESTION_S3_*` defaults and flips `INGESTION_STORAGE_BACKEND=s3`.
