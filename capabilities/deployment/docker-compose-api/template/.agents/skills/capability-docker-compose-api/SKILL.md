---
name: capability-docker-compose-api
description: The app's Docker Compose `api` service — the production and hot-reload overlays the Compose roots `include` when FastAPI is deployed with Compose. Use when the `api` container will not boot or stay healthy, when changing its build target, ports, env, or healthcheck, when `DATABASE_URL` or the encryption mode is wired wrong, or when adding a service dependency.
---

# Docker Compose — API

The `api` service for the Compose stack, as a production overlay + a hot-reload dev overlay — this
capability owns **only those two files**, each declaring `services.api`. Hidden integration:
activates when both `docker-compose` and `fastapi` are effective. Defers to `docker-compose` (Compose
roots, shared `init` service, `registry_token` secret), `fastapi` (`deploy/docker/Dockerfile.api`),
`postgres` (the `postgres` service), and the hidden auth integration (`compose.api.auth.dev.yaml`).

## Where things live

| Path | What |
| --- | --- |
| `deploy/compose/compose.api.yaml` | Production `api`; `include`d by `compose.yaml` when FastAPI is effective. Hardened rootfs; builds `Dockerfile.api` target `api`. |
| `deploy/compose/compose.api.dev.yaml` | Hot-reload `api`; `include`d by `compose.dev.yaml`. Bind-mounts source; builds target `api-dev`. |

## Extend

- Both files open with `name: app` (shared project) — a mismatch breaks the `include`. Keep it.
- The dev root merges this overlay with `compose.api.auth.dev.yaml` when auth is effective, so
  editing this file alone never covers the auth-gated dev shape.
- **Service dependency:** add a `depends_on` entry. `init` (`service_completed_successfully`) is
  unconditional; `DATABASE_URL` + `postgres` (`service_healthy`) render only when `postgres` is effective.
- **Env:** leave the encryption mode unpinned — both load it from app-root `.env` via `env_file`
  (keeps `api`/`workflows` agreeing); any mode but `off` needs `WORKFLOWS_ENCRYPTION_KEY`, so hardcoding
  a non-`off` mode crash-loops a no-`.env` stack. Dev adds `UV_NO_SYNC`, `WATCHFILES_FORCE_POLLING`,
  `MCP_APPS_ENABLED` (default `0`), `INGESTION_S3_ENDPOINT_URL: http://bucket:9000`.
- **Healthcheck:** both hit `/api/health/live` (fastapi's
  `apps/api/src/api/routers/api/internal/health.py`); dev lenient (`retries: 12`, `start_period: 60s`),
  prod (`retries: 5`, `start_period: 15s`). Both build `context: ../..`.
- **Build arg:** `REGISTRY_PY_USER` from `MISTRAL_REGISTRY_USER` (unset: the user `tools/uv.sh` pins) + the
  `registry_token` secret reach the private Python index.

## Gotchas

- Ports publish `127.0.0.1:3000:3000` (loopback only, for local debug + MCP tunnel); binding `0.0.0.0`
  opens a gateway-bypassing LAN path to the API.
- Production hardens the container (`read_only` + `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`,
  `init: true`, `stop_grace_period: 25s` covering uvicorn's 20s graceful shutdown); dev drops it for a
  writable bind-mount (`../..:/app`, anonymous `/app/.venv`). Both set `HOME=/tmp` (Agents SDK writes
  `~/.vibe` at import).
