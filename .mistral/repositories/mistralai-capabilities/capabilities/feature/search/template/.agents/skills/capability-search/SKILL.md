---
name: capability-search
description: The corpus-retrieval feature — the `mistralai_capabilities.search` store backends (`local`/`postgres`/`vespa`), the five retrieval activity-tools, the scheduled reconciling ingestion sweep, and the six tools it contributes to the single orchestrator agent. Use when picking a backend (`SEARCH_BACKEND`), touching the dense+BM25 hybrid path or rerank, working on reconcile/ingestion or the ANN rebuild, editing the per-tool files `tools/{search_search,search_open,search_navigate,search_read,search_grep}.py`, or running the `search:ingest` / benchmark scripts.
---

# Search

Worker-only hybrid retrieval over an ingested corpus, reached through an **agent, not an HTTP route** (no `apps/api` router). Owns the published `mistralai_capabilities.search` toolkit (three store backends behind one `SearchStore` Protocol, five retrieval activity-tools, eight-activity reconciling ingestion, offline eval harness), the `db` models for the tables it writes (`search.py` + `ingestion.py`, contributed into the `db` package), plus the app-vendored wiring. Defers to `core` (workspace/`env`), `postgres` (the `db` package, corpus, HNSW index), `bucket` (S3 ingestion source), `agents` (the single orchestrator agent and its per-kind contribution seam), `workflows` (workflow/activity contract + Search plugin — see `capability-workflows`).

## Where things live

Installed toolkit — `mistralai_capabilities.search.<mod>`:
| Module | What |
| --- | --- |
| `schemas` | Loop-boundary contract: request/result pairs, `FilteredVectorSearchQuery`, `OperationFailure` taxonomy, `CollectionConfig`, `group_results`; deployment constants derived from `env`. |
| `store` | `SearchStore` Protocol, `SourceMetadataStore` (`search_sources`), pure offset/page/grep/cosine functions. |
| `local_store` / `postgres_store` / `vespa_store` | Backends: in-memory dense-only (SDK `StoreIndex`); thin adapters over `PostgresStoreIndex` / `VespaStoreIndex`. |
| `vespa_app/migrations/001_create_index_schema.py` | Vespa schema + `hybrid-search` profile; `embedding_dimensions=128`, immutable (add `00X_*.py`). |
| `activities` | Five retrieval activity-tools, `_open_store` backend selection, LLM `_rerank`. |
| `reconcile` | Eight worker-only reconcile activities, pipeline registration, mass-purge guard, manifest upsert, HNSW rebuild. |
| `evaluation` / `retrieval_quality` | Synthetic MD5-embedding fixture; IR metrics via `RetrieverEvaluator` (shared with `evals`). |

Vendored into the app:
| Path | What |
| --- | --- |
| `apps/worker/src/worker/workflows/search.py` | `SearchReconcileWorkflow`; re-exports plugin `IngestDocumentsWorkflow`/`IngestBatchWorkflow` for worker discovery. |
| `packages/py/env/src/env/{search,ingestion}.py` | `SEARCH_BACKEND`, `SEARCH_AGENT_*`, Vespa settings; reconcile settings + frozen `INGESTION_COLLECTION_NAME`/`INGESTION_EMBED_MODEL`. |
| `apps/worker/src/worker/agents/tools/{search_search,search_open,search_navigate,search_read,search_grep}.py` | One file per retrieval tool, each exposing `tool`; `mistralai_capabilities.agents.assembly` merges them into the single orchestrator agent (the Unified Harness has no subagents). |
| `packages/py/cli/src/cli/commands/ingest.py`, `tools/bench_search_backends.py`, `tasks/search/project.json` | Dispatch one reconcile pass (`python -m cli ingest`); backend benchmark; NX `search:ingest` target. |
| `apps/worker/tests/test_feature_{search,reconcile}.py` | Retrieval + `tools/` tool-surface tests; reconcile tests. |

## Extend

- **Add a backend:** implement the `SearchStore` Protocol (remote adapters share `SourceMetadataStore`); wire selection in `activities._open_store` off `env.search_backend`.
- **New retrieval tool:** stack `@agents.tool` over `@workflows.activity` in `activities` (`name=` = `def` name, request param named `args`, and the pinned SDK needs `input_schema=<Request>` + `model_access="direct"`); add `tools/<name>.py` exposing `from mistralai_capabilities.search.activities import <name> as tool`. Reconcile activities stay ops-only (no `@agents.tool`) — every corpus write lives in `reconcile.py`.
- **Change embedding model:** a deliberate re-provisioning migration, not a config edit — keep `db.models.search.EMBEDDING_DIM`, Vespa `embedding_dimensions`, and `INGESTION_EMBED_MODEL` all equal (the plugin never alters an existing `halfvec(128)` column).
- **Orchestrator tools:** the `search-subagent` slot is gone (the Unified Harness has no subagents). The five retrieval tools reach the single orchestrator agent via one file per tool under `tools/` (each exposing `tool`); PLAN→search→verify→cite guidance now lives in the orchestrator's instructions (owned by the `agents` capability). The stateful `SearchLoopHook`/`SearchLoopState` loop-budget enforcement and the `manage_evidence` tool it backed were dropped — the worker path rejects stateful hooks.

## Gotchas

- Hybrid is the query **text**, not a method: `_run_search` blanks `query` to turn fusion off; no backend defines `hybrid_search`, so feature-detecting it silently leaves fusion on.
- Renaming `INGESTION_COLLECTION_NAME` orphans the corpus silently (PK prefix + `{collection}_chunks`); keep it and `_DEFAULT_COLLECTION` equal.
- Every reconcile pass that wrote ends with `search_reindex_ann` (`REINDEX INDEX CONCURRENTLY`, postgres-only) — incremental HNSW recall is ~0.20 vs ~1.00 rebuilt.
