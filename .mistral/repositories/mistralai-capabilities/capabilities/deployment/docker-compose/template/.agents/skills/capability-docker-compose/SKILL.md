---
name: capability-docker-compose
description: The app's Docker Compose stack — the two lifecycle roots (`compose.yaml` / `compose.dev.yaml`), the one-shot init chain, the `Dockerfile.init` runtime image, the `compose` nx tasks, and the smoke runbook. Use when the local stack will not come up, when adding or reordering a deployment init step, when changing which service overlays a root includes, when touching the `MISTRAL_REGISTRY_TOKEN` build secret or the init image, or when running the end-to-end smoke test.
---

# Docker Compose

Owns the shared Compose skeleton: the two lifecycle roots (`compose.yaml` prod / `compose.dev.yaml` hot-reload), the one-shot init chain (`compose.init.yaml`) that gates the stack, the `init` runtime image, and the `compose` nx tasks + smoke runbook. Owns **no per-service overlay**: each `compose.<service>.yaml` is shipped by a hidden `docker-compose-<service>` integration (api/web/workflows/postgres/bucket); the gateway root + APISIX/Keycloak config + `Dockerfile.gateway` by `docker-compose-auth`; the `cli` package that carries the init **step commands** (`packages/py/cli/`) plus `tools/uv.sh` and `tools/docker/sync-python-workspace.sh` by core.

## Where things live

| Path | What |
| --- | --- |
| `deploy/compose/compose.yaml` | Canonical (prod) root: `include:`s `compose.init.yaml` + one gated service overlay per deployed service; declares the `registry_token` build secret. |
| `deploy/compose/compose.dev.yaml` | Hot-reload dev root: same include model plus `.dev` overlay variants and the `bucket` overlay (dev only). |
| `deploy/compose/compose.init.yaml` | Init chain: one `init-<step>` service per installed step + the `init` aggregator gate, sharing the `x-init-step` anchor. |
| `deploy/compose/README.md` | Vendored operator runbook: stack assembly, init extension, smoke config/teardown. |
| `deploy/docker/Dockerfile.init` | `init` target image — canonical Python workspace runtime, no entrypoint; byte-identical with api/worker; pinned `${COMPOSE_PROJECT_NAME}-init:local` (one tag per project, never shared between apps); `COPY`s core `tools/uv.sh` + `tools/docker/sync-python-workspace.sh`. |
| `tools/compose.sh` | nx lifecycle dispatch (`up`/`down`/`dev`/`dev-down`/`build-images`/`logs`/`smoke`/`init`/`init-steps`); passes the root `.env` as `--env-file` and forwards extra arguments (`bunx nx run compose:dev -- --remove-orphans`); reads the step list from `compose.init.yaml`. |
| `tools/smoke.sh` | End-to-end smoke test: PASS/FAIL/SKIP verdict + exit code; SKIPs absent optional modules/creds; runs discovery in one-off `--no-deps` containers. |
| `tasks/compose/project.json` | `compose` nx project — the eight public targets. |
| `tests/test_deploy_compose_tasks.py`, `tests/test_compose_init_steps.py` | Pin the target set and that every rendered init service names a vendored `cli` command module (`packages/py/cli/src/cli/commands/`). |

## Add a step / overlay

- **Service overlay** → belongs to a hidden `docker-compose-<service>` (or `docker-compose-auth`) integration, never inline in a root. Each root references an overlay gated on its owning capability, so the stack never names a missing file.
- **Init step** → add both halves: a command module under `packages/py/cli/src/cli/commands/` (core) and a service here merging `<<: *init-step`, chained in order via `depends_on … condition: service_completed_successfully`. Put it behind the `init` aggregator gate only if the app must not start until it completes. Existing steps, each gated on its owner: `init-migrations` (postgres), `init-guardrail` (guardrailing), `init-prompts` (agents), `init-agents` (chat), `init-schedules` (evals). `init-agents`/`init-schedules` run **after the worker**, deliberately outside the gate. Steps must be idempotent (the chain re-runs every `up`). If `helm` is installed, mirror it in that chart's init subchart.
- `init` discovers steps by grepping `^  init-<step>:` from the rendered `compose.init.yaml` (aggregator excluded, empty match = clean success) and runs each as `python -m cli <step>` in file order via `tools/uv.sh`.

## Gotchas

- `registry_token` (BuildKit secret from `MISTRAL_REGISTRY_TOKEN`) is declared **once per root** — never in `compose.init.yaml`; a second declaration in an included file is rejected. Export `MISTRAL_REGISTRY_TOKEN` before any build target.
- The project is named after the app (`name:` in the two roots; overlays carry none), so two generated apps never share containers, volumes or the init image. `COMPOSE_PROJECT_NAME` in the shell or root `.env` overrides it. Host ports are `GATEWAY_PORT`/`KEYCLOAK_PORT`/`API_PORT`/`WEB_PORT`/`POSTGRES_PORT`/`BUCKET_PORT`/`BUCKET_CONSOLE_PORT` in the root `.env`; they only apply through `tools/compose.sh` (or your own `--env-file .env`), since Compose's project directory is `deploy/compose`.
- `dev` builds first and, when that changed an image, starts with `--renew-anon-volumes`, so a rebuilt image's new dependencies reach the `/app/.venv` and `node_modules` anonymous volumes (renewing recreates every container, so it is skipped when nothing was rebuilt). It never passes `--remove-orphans` unless you add it.
- Image build is `build-images`, not `build` (avoids nx's inferred TS `build`); `up` rebuilds by default, `bunx nx run compose:up -- --no-build` reuses existing images.
