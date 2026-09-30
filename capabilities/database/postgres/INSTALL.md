# Install — `@mistralai-capabilities/database-postgres`

Adds Postgres persistence: the app-local `db` package (async engine and session, Alembic setup) and
its migration tasks. Each capability that owns a table ships its own baseline migration.

## Prerequisites

- Sibling capabilities: `core`.
- A Postgres server. Outside Docker Compose it must provide the `vector` (pgvector) extension, and
  for `search` also `pg_textsearch` in `shared_preload_libraries`; stock `postgres` images have
  neither. The pinned `timescale/timescaledb-ha:pg18.4-ts2.29.0` image ships both.
- `DATABASE_URL` pointing at that server (default
  `postgresql+asyncpg://postgres:postgres@localhost:5432/postgres`). When it is unset and
  `POSTGRES_HOST` is non-empty, the URL is built from the `POSTGRES_*` variables, which is what managed
  Postgres on Mistral Apps provides.

## Install

```bash
mistral apps capability add postgres
bun run install-all   # sync the new dependencies
bunx nx run db:migrate   # alembic upgrade heads
```

Verify with `bunx nx run db:test-pg-contract`, which runs the live-Postgres contract suites and
self-skips when no suite is installed.

## Environment reference

| Variable                                        | Generated default                                                |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                  | `postgresql+asyncpg://postgres:postgres@localhost:5432/postgres` |
| `POSTGRES_HOST`                                 | empty                                                            |
| `POSTGRES_PORT`                                 | `5432`                                                           |
| `POSTGRES_USER`                                 | `postgres`                                                       |
| `POSTGRES_PASSWORD`                             | empty                                                            |
| `POSTGRES_DB`                                   | `postgres`                                                       |
| `POSTGRES_SSL_MODE`                             | empty                                                            |
| `DB_ECHO`                                       | `false`                                                          |
| `DB_POOL_SIZE`                                  | `5`                                                              |
| `DB_MAX_OVERFLOW`                               | `10`                                                             |
| `DB_POOL_PRE_PING`                              | `true`                                                           |
| `INIT_MIGRATIONS_DB_READY_TIMEOUT_SECONDS`      | `90.0`                                                           |
| `INIT_MIGRATIONS_DB_READY_SUCCESSES`            | `3`                                                              |
| `INIT_MIGRATIONS_DB_READY_INTERVAL_SECONDS`     | `2.0`                                                            |
| `INIT_MIGRATIONS_DB_READY_PING_TIMEOUT_SECONDS` | `2.0`                                                            |
