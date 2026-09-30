---
name: capability-docker-compose-workflows
description: The Compose plumbing for the durable worker — the `workflows` service in `compose.workflows.yaml` (prod) and `compose.workflows.dev.yaml` (hot-reload) plus the `workflows.defaults.env` baseline, `include`d by the Compose roots when both `docker-compose` and `workflows` are effective. Use when the `workflows` container will not start or stay healthy, when changing its build target or hardening, when wiring its env (tracing, Postgres, bucket, MCP), or when the dev and prod overlays drift.
---

# Docker Compose — Workflows

The Compose seam wiring the durable worker into a stack — owns only the `workflows` service: two
overlays (prod + hot-reload) + their defaults env. Worker image/app code/workflow definitions belong
to `workflows`; root `compose.yaml`/`compose.dev.yaml` + init chain to `docker-compose`; gateway/bucket
to the hidden `docker-compose-auth`/`docker-compose-bucket` integrations; cluster to Helm.

## Where things live

| Path | What |
| --- | --- |
| `deploy/compose/compose.workflows.yaml` | Prod service — hardened, health-checked; `include`d by `compose.yaml`. |
| `deploy/compose/compose.workflows.dev.yaml` | Hot-reload service — bind-mounted source, no hardening; `include`d by `compose.dev.yaml`. |
| `deploy/compose/workflows.defaults.env` | First `env_file` baseline (`OTEL_ENABLED=false`); later entries override. |

Both overlays build from `deploy/docker/Dockerfile.worker`, pass `REGISTRY_PY_USER`, mount the
`registry_token` secret, `depends_on` the shared `init` service, and carry `name: app` (with the roots)
to merge into one project. `env_file` order is `workflows.defaults.env` then `../../.env`
(`required: false`); later wins.

- **Prod** (`workflows` target) locks down: `read_only: true` + `/tmp` tmpfs, `cap_drop: ALL`,
  `no-new-privileges`, `init: true`, `HOME=/tmp` (nuage_v2/`vibe` writes `~/.vibe` at import). Health
  server loopback `127.0.0.1:3001`; healthcheck `GET /health` via `python -c urllib`. `restart: unless-stopped`.
- **Dev** (`workflows-dev`) drops hardening but keeps the same health server + healthcheck (with a
  60s `start_period`). `watchfiles` survives a worker that crashes at startup, so `unhealthy` in
  `docker compose ps` is the signal to read the worker logs. It bind-mounts `../..:/app` (anon `/app/.venv`),
  sets `UV_NO_SYNC=1` + `WATCHFILES_FORCE_POLLING=true`, wires MCP (`MCP_SERVER_URL` `http://api:3000/mcp`,
  `MCP_APPS_ENABLED=0`), and sets `INGESTION_S3_ENDPOINT_URL=http://bucket:9000` unconditionally.

## Extend

Add a sibling capability's env by appending a conditional block (gated on it being effective) to both
overlays, mirroring the existing pairs:
- **`postgres`** → `DATABASE_URL` (`postgres://…@postgres:5432/postgres`, coerced to asyncpg by
  `env/db.py`) + `SEARCH_BACKEND=postgres` + a `postgres: service_healthy` dep.
- **`observability`** → `MISTRAL_SDK_TELEMETRY=global`; also writes `OTEL_ENABLED=true` into root `.env`.

Change build target/hardening in the matching overlay; keep prod and dev from drifting.

## Gotchas

- Tracing/encryption stay off until the generated root `.env` sets them (later `env_file` wins);
  encryption rides the same root `.env` as `api`.
- Read-only rootfs: startup writes must land on the `/tmp` tmpfs (hence `HOME=/tmp`).
