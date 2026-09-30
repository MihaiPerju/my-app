---
name: capability-docker-compose-bucket
description: The Compose delivery of the local bucket — the RustFS `bucket` service and the one-shot `bucket-setup` seeder in `deploy/compose/compose.bucket.yaml`, included by the dev Compose root. Use when the local bucket will not come up or the worker cannot reach it, when changing the RustFS image, ports, or credentials, or when changing how the `./ingest` corpus seeds the store.
---

# Docker Compose — Bucket

The Compose half of the local **bucket** store — the object-storage service the `s3` ingestion backend talks to in local dev. Owns the *service* only (RustFS server + seeder, one overlay); the client side (`mistralai_capabilities.bucket`, the `s3` backend, `INGESTION_S3_*`) belongs to **`bucket`**, and the `include:` pulling it in belongs to **`docker-compose`**'s `compose.dev.yaml`. Hidden (`visible: false`): renders only when both `docker-compose` and `bucket` are effective. No prod/Helm delivery — real deploys point `INGESTION_S3_*` at managed storage.

## Where things live

`deploy/compose/compose.bucket.yaml` — object-store overlay, `name: app` (merges into the shared `app` project); `include`d by `compose.dev.yaml` gated on `bucket`, so it comes up with `bunx nx run compose:dev`; absent from `compose.yaml`. Two services:

- **`bucket`** — `rustfs/rustfs:1.0.0-beta.11`, S3 API `:9000` + console `:9001` (both published on `127.0.0.1`), `bucket_data` volume, `curl /health` healthcheck, `restart: unless-stopped`.
- **`bucket-setup`** — one-shot `rustfs/rc:v0.1.36` (RustFS's own mc-compatible S3 CLI; `restart: "no"`); waits for `bucket` healthy, `rc mb --ignore-existing` the ingestion bucket, `rc mirror --overwrite --remove` the read-only `../../ingest` bind (repo-root `ingest/`) into `${INGESTION_S3_BUCKET:-ingest}`.

## Extend

- **Local corpus:** edit repo-root `ingest/` and re-up; the seeder re-syncs idempotently on every `up`.
- **Image / ports / creds:** edit `compose.bucket.yaml`. `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` (default `bucketadmin`/`bucketadmin`) feed server + seeder; the client's `INGESTION_S3_ACCESS_KEY_ID`/`INGESTION_S3_SECRET_ACCESS_KEY` (owned by `bucket`) must change in step.
- **Reach the store:** host tools + a native worker use `127.0.0.1:9000`; a containerized worker uses `bucket:9000` with path-style addressing (wired by `bucket`).

## Gotchas

- Single named volume = one disk → needs `RUSTFS_UNSAFE_BYPASS_DISK_CHECK: "true"` (with `command: ["/data"]` + `bucket_data:/data`); without it RustFS won't start.
- Both images are pinned (`rustfs/rustfs` server + `rustfs/rc` seeder) — a broken seed is a config/corpus issue, not a floating-tag bump.
- In the inline seeder command, `$$RUSTFS_ACCESS_KEY` & friends are doubled to escape Compose interpolation.
