# Install — `@mistralai-capabilities/database-bucket`

Adds the `mistralai_capabilities.bucket` package (an async `Bucket` interface with S3, GCS, and
Azure backends) and selects the `s3` ingestion storage backend. With Docker Compose, a local
S3-compatible store (RustFS) is added to the stack.

## Prerequisites

- Sibling capabilities: `core`.
- Object storage: the local store from `docker-compose`, or real S3-compatible storage.
- `INGESTION_S3_*` variables pointing at that storage; the defaults target the local store
  (`http://127.0.0.1:9000`, bucket `ingest`, credentials `bucketadmin`/`bucketadmin`). Set real
  credentials for any non-local deployment.

## Install

```bash
mistral apps capability add bucket
bun run install-all   # sync the new dependencies
```

Verify the package resolves:

```bash
bash tools/uv.sh run --no-sync python -c "from mistralai_capabilities.bucket import Bucket, S3Bucket; print(Bucket, S3Bucket)"
```

With `docker-compose`, `bunx nx run compose:dev` starts the store, creates the bucket, and mirrors
`./ingest` into it.

- Changing the local store's `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` requires the same change to
  `INGESTION_S3_ACCESS_KEY_ID` / `INGESTION_S3_SECRET_ACCESS_KEY`, or the app cannot authenticate.

## Environment reference

| Variable                         | Generated default       |
| -------------------------------- | ----------------------- |
| `INGESTION_STORAGE_BACKEND`      | `s3`                    |
| `INGESTION_S3_ENDPOINT_URL`      | `http://127.0.0.1:9000` |
| `INGESTION_S3_BUCKET`            | `ingest`                |
| `INGESTION_S3_ACCESS_KEY_ID`     | `bucketadmin`           |
| `INGESTION_S3_SECRET_ACCESS_KEY` | `bucketadmin`           |
