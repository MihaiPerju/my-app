---
name: capability-fastapi
description: The app's generic HTTP host — `apps/api`, the file-based router whose directory tree is the URL tree, the `/api/health*` probe routes, and the deterministic `FastAPIHooks` seams (configure / lifespan / health), backed by the `mistralai_capabilities.fastapi` toolkit (router loader, SSE encoder, `gen-openapi`). Use when adding or debugging a route, when a subtree raises `UndeclaredAccessRuleError`, when wiring a startup/shutdown/readiness/health hook, when regenerating the OpenAPI schema or fixing CORS, or when deciding whether code belongs in this host or the `fastapi-auth` / `fastapi-workflows-auth` overlays.
---

# FastAPI

The app's generic HTTP host at `apps/api` — a file-based router (directory tree = URL tree), the unversioned `/api/health*` probes, and app-local `FastAPIHooks` seams — owning generic delivery only (routes, middleware, lifecycle, SSE) and depending only on `core`, so a bare app boots without `db`/`workflows-app`. Auth, the persisted stores, and the workflow-execution surface arrive as routers and hooks dropped into `apps/api` by the hidden `fastapi-auth` / `fastapi-workflows-auth` overlays; the delivery machinery it owns (router loader, SSE encoder, hook runtime, `gen-openapi`) ships in the imported `mistralai_capabilities.fastapi` toolkit.

## Where things live

| Path | What |
| --- | --- |
| `apps/api/src/api/main.py` | `create_app(*, hooks=None)` factory: logging + optional telemetry, `FastAPIHooks` lifespan, CORS from `env.api`, mounts `create_api_router("api.routers")`; serves module-level `app`. |
| `apps/api/src/api/routers/` | File-router root; `routers/api/` is the `/api` prefix. Ships only `api/internal/`; features add subtrees here. |
| `apps/api/src/api/routers/api/internal/` | `segment=""`, `dependencies=()`: `health.py` serves `/api/health{,/live,/startup,/ready}` + reads the `/tmp/drain` sentinel. |
| `apps/api/src/api/{configure,lifespan/startup,lifespan/shutdown,health/report,health/ready,health/metadata}/` | The six empty hook seams. |
| `packages/py/env/src/env/api.py` | `env.api` — `cors_origin` ← `CORS_ORIGIN`. |
| `apps/api/pyproject.toml` | `api-app` dist: pins `fastapi[standard-no-fastapi-cloud-cli]>=0.137.2` (floor is load-bearing: the toolkit's router loader imports `fastapi.routing.iter_route_contexts`); adds `db`/`workflows-app` only when Postgres/workflows effective. |
| `apps/api/{project.json,tests/}` | NX `serve` (`python -m api.dev`) + `gen-openapi` targets; router-discovery, typed-response, unique-operation-id guard tests. |
| `apps/api/src/api/dev.py` | The dev server every launcher runs: uvicorn reload over `apps/api/src` + `packages/py/*/src` (never `tests/`), 3 s graceful shutdown so an open stream cannot wedge a reload. |
| `deploy/docker/Dockerfile.api` | API image (`api` runtime + `api-dev` hot-reload). No Compose/Helm ship here. |

## Add a route

The directory tree is the URL tree — add a file under `routers/`; `main.py` never changes.
- Package name = URL segment unless it sets `segment` (`""` collapses onto parent); `route.py` = dir index; `foo.py` → `foo`; `[thing]` in any name → `{thing}`; `_`-prefixed modules and a module with no module-level `router` are silently skipped.
- Every group declares `dependencies: tuple[params.Depends, ...]` in `__init__` (cascades to descendants); `()` = explicit anonymous. Feature routes live under `v1/<feature>/` behind `fastapi-auth`'s `require_user` gate (rendered by the overlay, not here).
- After changing any request/response model run `bunx nx run api:gen-openapi` → writes `apps/api/openapi.json`, the source of truth for web `gen-types`.

## Add a hook

Drop one module into a seam dir under `apps/api/src/api/`; discovered by basename, run in sorted order (no `main.py` edit):
`configure/` `configure(app)->None`; `lifespan/startup/` `async startup(app)`; `lifespan/shutdown/` `async shutdown(app)` (reverse order); `health/report/` & `health/ready/` `async check()->bool` (basename = `deps` label); `health/metadata/` `metadata()->str|None` (basename = field, e.g. `deployment`). Streaming: reuse toolkit `event_stream_response`/`format_sse`.

## Gotchas

- Where the generic `fastapi` skill disagrees with this one (router prefixes, SSE helpers, `fastapi run`), this one wins: routes go through the file router, SSE through the toolkit, and the image serves with uvicorn.
- Serve in dev with `bunx nx run api:serve` (`python -m api.dev`), never `fastapi dev`: it has no graceful-shutdown bound, so one open chat stream hangs its reload.
- Keep `api/__init__.py` empty — importing `api` must not construct the app or pull in FastAPI.
- Fail-closed: a route reached with no declaring `dependencies` ancestor raises `UndeclaredAccessRuleError`; a missing/non-callable/duplicate hook symbol raises `FastAPIHookDiscoveryError`; two modules on one URL raise `DuplicateRouteError`.
- Anything that names a feature, reaches a store, or asserts identity belongs in an overlay, not this generic host.
