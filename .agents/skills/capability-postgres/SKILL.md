---
name: capability-postgres
description: The app's persistence layer — the `db` package (the async engine, the Alembic setup, and the `models`/`accessors`/`migrations` directories the capabilities that own each table fill in), the `env.db`/`env.init` settings, the `migrations` deploy step, and the first-boot `vector` extension script. Use when writing a migration or changing the schema, when adding an accessor to the ORM query surface, when wiring `DATABASE_URL` or the async engine and pool, or when the `vector` (pgvector) extension or its HNSW index will not build. The Postgres *server* — the compose overlay and the in-cluster Helm subchart — ships from the hidden `docker-compose-postgres` / `helm-postgres` integrations, not here.
---

# Postgres

The app-local persistence layer everything writes through — the `db` package (the async engine and Alembic setup; models and accessors are contributed by the capabilities that own each table), `env.db`/`env.init` settings, the `migrations` deploy step, and the first-boot `vector` extension script. It owns the **client and migration scaffolding**, not the schema (contributed per table) or the server (compose `postgres` ships from `docker-compose-postgres`, Helm subchart from `helm-postgres`); `search` and `guardrailing` persist through it.

## Where things live

| Path | What |
| --- | --- |
| `packages/py/db/` | NX `db` project: `engine.py` (lazy async engine + `ping`/`readiness_ping`), `migrations/` (Alembic setup; `versions/` holds one baseline branch per table-owning capability), `schema_filter.py` (autogenerate ignores tables no model declares), and `models/`/`accessors/` discovery dirs the capabilities that own each table fill in (`models/__init__.py` imports whatever is present so `SQLModel.metadata` stays complete). `db/__init__.py` exports the engine + `metadata`; a caller imports a concrete accessor (`from db.accessors.users import upsert_user`). |
| `packages/py/env/src/env/db.py` | `env.db` — `DATABASE_URL` default, or a URL built from `POSTGRES_*` when only those are set; `async_database_url` (coerces `postgres*://` → `+asyncpg`), pool knobs. |
| `packages/py/env/src/env/init.py` | `env.init` — migration-readiness knobs (`init_migrations_db_ready_*`). |
| `packages/py/cli/src/cli/commands/migrations.py` | `python -m cli migrations`: wait for a stable DB-ready window, then `alembic upgrade heads`. |
| `deploy/docker/postgres/init/00-extensions.sql` | First-boot `CREATE EXTENSION` for `vector` and `pg_textsearch`; compose mounts it as `020-extensions.sql`. Compose only. |
| `tools/db.sh` | NX tasks behind `bunx nx run db:<target>`: `migrate` / `revision` / `downgrade` / `test-pg-contract`. |

## Add a table / schema change

1. In the owning capability's `template/packages/py/db` overlay, add `models/<table>.py` (auto-discovered, so `SQLModel.metadata` stays complete) and `accessors/<table>.py`; import the accessor by its concrete path (`from db.accessors.<table> import …`).
2. A capability that owns a table also ships its baseline, `migrations/versions/<cap>_0001_<table>.py`: `revision = "<cap>_0001"` (≤32 chars), `down_revision = None`, `branch_labels = ("<cap>",)` (id with `_` for `-`). Never chain onto another capability's revision — owners vary per composition. `tests/registry/templates/db-migrations.test.ts` enforces this, and `test_migrations_pg.py` (`db:test-pg-contract`) runs `alembic check` so the baseline cannot drift from the model.
3. In an app, `bunx nx run db:revision --message "…"` autogenerates from live metadata on top of every capability head (`--head heads`, so that first revision also merges the branches) (`db:migrate` applies to `heads`, `db:downgrade` reverts one step, off a merge revision too). Autogenerate ignores tables no model declares (`db.schema_filter`) — the plugin's `<collection>_chunks`, `guardrail_embeddings`, PostGIS tables — and can't see extensions; `search_0001` creates `vector`/`pg_textsearch` best-effort. The embedding width lives in `db.models.search.EMBEDDING_DIM` (contributed by `search`); a width change needs a deliberate migration to re-provision the chunk table (the plugin never alters an existing column).
4. The `workflow_executions` accessors (contributed by `fastapi-workflows-auth`) carry the ownership-triple + idempotency invariants the execution routes reach ownership through.

## Gotchas

- **`vector` required, two authorities.** The chunk table's `halfvec(128)` column needs pgvector (needs `timescale/timescaledb-ha:pg18.4-ts2.29.0`, not stock `postgres:18`). Two authorities: `00-extensions.sql` (compose first-boot only — `docker compose down -v` to re-fire) and, for Helm/managed targets, the best-effort `CREATE EXTENSION IF NOT EXISTS` in the `search_0001` baseline (a NOTICE where the role may not; the plugin then refuses with a named error); add an extension in **both**. `pg_textsearch` must also be in `shared_preload_libraries` (the pinned image preloads it).
- **Engine is lazy** — `get_engine()` opens no connection on import. `readiness_ping()` uses a `NullPool` (per-call connect) so a saturated pod never marks itself unready; probes use it, `/api/health` uses `ping()` (shared pool, so `False` = unreachable *or* saturated).
