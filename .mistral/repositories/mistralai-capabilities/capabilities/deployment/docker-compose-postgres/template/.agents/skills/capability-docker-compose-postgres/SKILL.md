---
name: capability-docker-compose-postgres
description: The hidden Compose × Postgres overlay — the single `compose.postgres.yaml` that runs Postgres as a local Compose service, `include`d by the Compose roots when Postgres runs under Compose. Use when the local `postgres` container will not start or stay healthy, when editing its image/port/volume or the bind-mounted extension script, or when the `postgres` service is missing from the rendered `compose.yaml`.
---

# Docker Compose — Postgres

A **seam**, not a component: the one file that makes Postgres a local Compose service. It owns only the Compose *service definition*; the server concept, `vector`/TimescaleDB image rationale, extension SQL, `DATABASE_URL` wiring, and in-cluster equivalent belong to `capability-postgres` (and its Helm sibling); schema/models/migrations live in `packages/py/db`. Hidden (`visible: false`); activates only when **both** `docker-compose` and `postgres` are effective (`activatedWhen.allOf`). Nothing here is imported at runtime.

## Where things live

| Path | What |
| --- | --- |
| `deploy/compose/compose.postgres.yaml` | The `postgres` service (owned here): pinned `timescale/timescaledb-ha` image, loopback port bind, `pg_data` named volume, extension-script bind-mount, `pg_isready` healthcheck. |
| `deploy/docker/postgres/init/00-extensions.sql` | First-boot extension script, owned by `postgres`, bind-mounted in. |
| `compose.yaml`, `compose.dev.yaml` | Compose roots (owned by `docker-compose`) that `include` this overlay, gated on the same AND condition. |

## Extend

- **Add/change an extension:** edit `00-extensions.sql` (in `postgres`), then recreate the volume via `docker compose down -v` — the init dir runs only against an empty volume.
- **Edit image/port/volume:** change `compose.postgres.yaml`. Host port is `127.0.0.1:${POSTGRES_PORT:-5432}`.
- **`postgres` missing** from `docker compose config`: overlay didn't render — confirm Postgres is effective and regenerate the roots; never add the service by hand.

## Gotchas

- `pg_data` mounts the **parent** of PGDATA (`/home/postgres/pgdata`, uid 1000).
- The extension script mounts as a single **file** at `020-extensions.sql` so it sorts after the image's own TimescaleDB init scripts; a directory mount would shadow them and silently drop TimescaleDB.
