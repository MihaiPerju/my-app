# Install — `@mistralai-capabilities/feature-search`

Adds hybrid (ANN + BM25) corpus search: the search stores, the reconciling ingestion sweep from
object storage, and the retrieval agent tools.

## Prerequisites

- Sibling capabilities: `core`, `postgres`, `bucket`, `agents`, `workflows`.
- A Postgres with the `vector` (pgvector) and `pg_textsearch` extensions, `pg_textsearch` also in
  `shared_preload_libraries`. The Compose image ships both; on managed Postgres, have the database
  provisioner create them.
- An object-storage source to ingest from (`bucket` by default; filesystem, S3, GCS or Azure via
  `INGESTION_STORAGE_BACKEND`, which `bucket` declares).
- A running worker (`workflows`), connected to the platform at `WORKFLOWS_BASE_URL`, to execute
  ingestion.
- `MISTRAL_API_KEY`: required, every chunk is embedded through the Mistral API.
- `SEARCH_BACKEND`: `postgres` (default), `local` (in-memory, dev/test) or `vespa` (set the
  `VESPA_*` variables).
- `INGESTION_ENABLED`: `false` by default; set `true` to schedule the ingestion sweep. The schedule
  is applied by the `schedules` init step, which ships with `evals`; without `evals`, run
  `bunx nx run search:ingest` yourself.
- Do not change `INGESTION_COLLECTION_NAME` or `INGESTION_EMBED_MODEL` after the first ingest:
  renaming the collection silently orphans the corpus (searches return empty), and the chunk
  column is sized to the model's 128 dimensions.
- Without payload offloading on the worker (`ACTIVITY_ATTRIBUTES_OFFLOADING__*`), lower
  `INGESTION_BATCH_SIZE` to about `10` to stay under the 2 MB payload limit.
- The `SEARCH_AGENT_*` variables are inert: the orchestrator owns the loop budget.

## Install

```bash
mistral apps capability add search
bun run install-all   # sync the new dependencies
bunx nx run db:migrate
```

Verify with one ingestion pass (needs a reachable source and `MISTRAL_API_KEY`):

```bash
bunx nx run search:ingest
```

With `evals` installed, `bunx nx run evals:eval-search` checks retrieval quality.

## Environment reference

| Variable                                | Generated default               |
| --------------------------------------- | ------------------------------- |
| `MISTRAL_API_KEY`                       | empty; required                 |
| `SEARCH_BACKEND`                        | `postgres`                      |
| `VESPA_ENDPOINT`                        | empty; configure when used      |
| `VESPA_QUERY_PORT`                      | `18080`                         |
| `VESPA_CONFIG_PORT`                     | `19072`                         |
| `VESPA_APP_NAME`                        | `{{app_name}}`                  |
| `SEARCH_MAX_ATOMS_PER_SOURCE`           | `2000`                          |
| `SEARCH_AGENT_MAX_ITERATIONS`           | `10`; inert                     |
| `SEARCH_AGENT_TOOL_BUDGET`              | `20`; inert                     |
| `SEARCH_AGENT_CONTEXT_BUDGET`           | `40`; inert                     |
| `SEARCH_AGENT_PER_SOURCE_BUDGET`        | `8`; inert                      |
| `SEARCH_AGENT_COMPACT_THRESHOLD`        | `120000`; inert                 |
| `INGESTION_ENABLED`                     | `false`                         |
| `INGESTION_SCHEDULE_ID`                 | `{{app_name}}-ingestion`        |
| `INGESTION_INTERVAL_SECONDS`            | `86400`                         |
| `INGESTION_CRON`                        | empty; configure when used      |
| `INGESTION_SOURCE_PREFIX`               | empty; configure when used      |
| `INGESTION_FILESYSTEM_ROOT`             | empty; configure when used      |
| `INGESTION_S3_REGION`                   | empty; configure when used      |
| `INGESTION_S3_SESSION_TOKEN`            | empty; configure when used      |
| `INGESTION_GCS_BUCKET`                  | empty; configure when used      |
| `INGESTION_GCS_SERVICE_ACCOUNT_FILE`    | empty; configure when used      |
| `INGESTION_GCS_API_ROOT`                | empty; configure when used      |
| `INGESTION_AZURE_CONTAINER`             | empty; configure when used      |
| `INGESTION_AZURE_CONNECTION_STRING`     | empty; configure when used      |
| `INGESTION_AZURE_ACCOUNT_URL`           | empty; configure when used      |
| `INGESTION_AZURE_USE_WORKLOAD_IDENTITY` | `false`                         |
| `INGESTION_COLLECTION_NAME`             | `mistralai_capabilities_search` |
| `INGESTION_EMBED_MODEL`                 | `mistral-embed-dim128-2510`     |
| `INGESTION_BATCH_SIZE`                  | `20`                            |
| `INGESTION_MAX_CONCURRENT_BATCHES`      | `5`                             |
| `INGESTION_MAX_FILE_BYTES`              | `10485760`                      |
| `INGESTION_DELETE_THRESHOLD`            | `0.5`                           |
| `INGESTION_TOMBSTONE_GC_DAYS`           | `30`                            |
| `INGESTION_DRY_RUN`                     | `false`                         |
