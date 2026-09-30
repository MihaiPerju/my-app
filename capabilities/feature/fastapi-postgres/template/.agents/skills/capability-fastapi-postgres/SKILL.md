---
name: capability-fastapi-postgres
description: The hidden bridge wiring Postgres into the FastAPI host's discovered lifecycle — the `database` health-report probe, the readiness probe, and the engine-dispose shutdown hook. Use when the `/api/health` or readiness `database` entry is wrong, when adding a db-backed probe or shutdown step, when a probe silently reports `false`, or to see why `report` uses `ping` while `ready` uses `readiness_ping`.
---

# FastAPI × Postgres

The overlay wiring the `db` package's connection lifecycle into the FastAPI host's discovered hook slots. Exists **only when both `fastapi` and `postgres` are selected** (`activatedWhen.allOf: [fastapi, postgres]`) and is invisible in the catalog. It owns *only* this wiring — `db` functions live in `packages/py/db` (postgres); the hook framework and `/health` route belong to `fastapi`. Also carries an empty `package/ts` carrier (`export type FastApiPostgresCapability = never;`).

## Where things live

| Path | What |
| --- | --- |
| `apps/api/src/api/health/report/database.py` | `check = ping` — `database` entry in the `/api/health` report; runs on the shared app pool, so `False` = unreachable **or** saturated. |
| `apps/api/src/api/health/ready/database.py` | `check = readiness_ping` — `database` readiness probe on a `NullPool` engine, isolated from the app pool. |
| `apps/api/src/api/lifespan/shutdown/database.py` | `shutdown(_app)` → `await dispose_engine()`; disposes app pool + readiness engine on stop. |
| `apps/api/tests/test_postgres_hooks.py` | Asserts report/readiness catalogs surface `{"database": bool}`. |
| `apps/api/tests/support/postgres.py` | `postgres_hooks(*, report, ready)` builds a `FastAPIHooks` with `database` probes for tests. |

## Add a db-backed probe or shutdown step

`FastAPIHooks.discover("api")` (shipped by `fastapi`) walks `api.health.report`, `api.health.ready`, and `api.lifespan.shutdown` one level deep, sorted by module name. Module **stem = hook key** (`database.py` → `database`); each must declare the slot attribute — `check` (health) or `shutdown` (lifespan) — as a callable, or discovery raises `FastAPIHookDiscoveryError`. `_`-prefixed modules are skipped; a duplicate key within a package is rejected. Drop a file into the matching directory — nothing to register. A new query/connection helper is not this: it's a `db` function (`packages/py/db`, postgres).

## Gotchas

- Keep report on `ping` (shared pool; `False` = down or busy is fine) and readiness on `readiness_ping` (per-call `NullPool`) — readiness on the shared pool lets a busy replica mark itself unready and cascade the fleet down.
- A `check` is invoked as `probe()` with no args (so `timeout_s` must default); one that needs an arg or raises is caught and reported as a silent `database: false`, not a 500.
- `shutdown(app)` receives the app; shutdown hooks run in **reverse** order, each isolated — failures collected into an `ExceptionGroup`.
