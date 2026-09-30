---
name: capability-docker-compose-web
description: The `web` frontend's Docker Compose service, split into a prod overlay (`compose.web.yaml`) and a dev overlay (`compose.web.dev.yaml`) that the Compose roots `include` only when the web frontend runs under Compose. Use when the `web` container will not build or stay healthy under Compose, when changing its build target or the `VITE_API_URL` origin baked into the bundle, or when adjusting the dev bind-mount, loopback port, or health timing.
---

# Docker Compose — Web

The `web` frontend's Docker Compose service — two overlays adding one `web` service to the `app` project: `compose.web.yaml` runs the built `runtime` image, `compose.web.dev.yaml` runs the bind-mounted Vite dev server. Logically owned by `tanstack-start` (the frontend it runs); ships here only because the files are Compose-specific. It owns neither the image (`deploy/docker/Dockerfile.web`, from `tanstack-start`) nor the root `compose.yaml`/`compose.dev.yaml` that `include` it (from `docker-compose`).

## Where things live

| Path | What |
| --- | --- |
| `deploy/compose/compose.web.yaml` | Prod `web` — builds `Dockerfile.web` target `runtime`; hardened (`read_only` rootfs, `/tmp` tmpfs the only writable path, `cap_drop: ALL`, `no-new-privileges`); `include`d by root `compose.yaml`. |
| `deploy/compose/compose.web.dev.yaml` | Dev `web` — target `dev`, `NODE_ENV=development`, bind-mounts repo at `/app` (anon volumes over `node_modules`) for Vite HMR; `include`d by root `compose.dev.yaml`. |

Both declare `name: app` (one project, not two), wait on the API (`depends_on: api: service_healthy`), publish loopback-only (`127.0.0.1:3001:3001`), and mount the `registry_token` secret for private-registry installs. Dev healthcheck gives Vite room (`start_period: 60s`, 18 retries) vs prod's 15s/5.

## Extend

- Activates automatically when both `docker-compose` and `tanstack-start` are effective (`visible: false`, no code beyond the two overlays); either parent alone leaves it inert.
- Change build target, hardening, or health timing → edit the matching overlay only.
- Change the API origin: both resolve `${VITE_API_URL-http://localhost:3000}`. The unset-only `-` keeps an **explicit empty** value — what `docker-compose-auth` writes to point the frontend at the same-origin APISIX gateway. Prod bakes `VITE_API_URL` as a **build arg** into the static bundle (rebuild to change); dev reads it as an **env** var at Vite start.

## Gotchas

- Prod rootfs is `read_only` — anything the prod web container writes at runtime must land under `/tmp`.
