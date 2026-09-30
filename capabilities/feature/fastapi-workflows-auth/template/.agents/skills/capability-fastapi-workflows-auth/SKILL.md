---
name: capability-fastapi-workflows-auth
description: The authenticated workflow-execution HTTP surface — `WorkflowRouter`, the execution command/ownership/schema layer, its Postgres store, and the payload-encryption startup — wired in as a hidden overlay only when FastAPI, auth, and workflows are all selected. Use when mounting or tuning a `WorkflowRouter`, when an id-addressed route 404s on ownership, when a repeated `Idempotency-Key` starts a second run, when wiring the `ExecutionStore` → `db` seam, or when a workflow's signal/query/update route is missing.
---

# FastAPI Workflows Auth

Authenticated HTTP surface to start, observe, and stop workflow executions with per-user isolation. Owns `WorkflowRouter` (one workflow class → its whole execution route set), the execution **commands/ownership/schema** layer, the **Postgres execution store**, and the API-side **payload-encryption** startup. Hidden overlay (`visible: false`, `activatedWhen.allOf: [fastapi, auth, workflows]`) — materializes only when all three are effective and pulls in `postgres`. Defers to: `workflows` (definitions, worker discovery, `payload_encryption()`), `postgres`/`packages/py/db` (ownership+idempotency table and `db` accessors), `fastapi-auth` (`require_user`/`CurrentUser`), `fastapi` (SSE/routing/hooks). Where a router is *mounted* (its URL) is the caller's choice under `apps/api/src/api/routers/`.

## Where things live

Installed toolkit `mistralai_capabilities.fastapi_workflows_auth` (`…/` below) + 3 vendored app files:

| Path | What |
| --- | --- |
| `…/router.py` | `WorkflowRouter(workflow_class, *, name, …)` → execution `APIRouter`; `ExecutionRoute` (its `route_class`) re-labels a platform 404 as the unowned-id refusal; `_mounter` attaches the ownership guard to every `{execution_id}` path. |
| `…/commands.py` | Driving deps `Start`/`Stream`/`Cancel` + `Commands` facade; `RetryingExecutionCommands` retries the 7 side-effect-free reads. |
| `…/ownership.py` | `ExecutionStore` Protocol + `require_owned`/`require_owned_any`; `_executions()` raises until a store installs. |
| `…/schemas.py` | App-owned wire contract: `WorkflowExecution`, `ExecutionPage`, batch/accepted/trace/log models. |
| `…/stores.py` | `PostgresExecutionStore` + `install_execution_store` — the only module importing `db`. |
| `apps/api/src/api/configure/workflows_auth.py` | `configure = install_execution_store` — discovered hook binding store + retrying-commands. |
| `apps/api/src/api/lifespan/startup/workflows_auth.py` | `startup` runs `payload_encryption()` once at boot. |
| `apps/api/tests/support/workflows_auth.py` | `FakeExecutor`, `FakeExecutionStore`, `workflow_auth_hooks()` test doubles. |

## Add / change a workflow route

- **Mount**: add a module under `apps/api/src/api/routers/` that builds `WorkflowRouter(workflow_class, *, name, …)` and includes it — the file's location IS the URL.
- **`name`**: op-id namespace naming the generated client's methods; free to differ from catalog identity; **not** the URL.
- **Ownership**: derives from the workflow's catalog name (`@workflow.define(name=…)`); `ownership_name=` optionally *asserts* it — a mismatch (or a class with no definition) fails construction with `WorkflowRouteConfigurationError`.
- **Route set**: ≤19 ops = 16 unconditional + `execution_signal`/`_query`/`_update` when the workflow declares that handler; `operations=` overrides the derived set.
- **`request_model=`/`input_adapter=`**: escape hatch when input can't be reflected (e.g. discriminated union); `request_model=` carries the response model with it.
- **`wait_for_result`**: create route only — `200` result vs `202` `WorkflowExecution`; a waited create has no idempotency.
- **`on_create`**: create-time hook inside the ownership window; return falsy (→404) or a `CreateRefusal` to refuse — must **not** raise `HTTPException`. **`stream_events`**: per-request event-frame mapper.
- **Add an operation**: put its response model in `schemas.py`, narrowed the app way (`_status` → closed union / `"UNKNOWN"`; read off every `_SdkExecution` arm). `ExecutionEvent`/`StreamError` are SSE-only, never response models.
- **Wire behaviors**: file-discovered — drop a `configure`/`startup` module in the seam dir; `FastAPIHooks.discover()` scans `api.configure` + `api.lifespan.startup` (no registration list). `install_execution_store(app)` overrides `_executions`→`PostgresExecutionStore` and `_commands`→`RetryingExecutionCommands` (built eagerly) via `dependency_overrides`.
- **Test**: override collaborators via `dependency_overrides`; `workflow_auth_hooks(executor, executions)` returns `FastAPIHooks` overriding `_executions`/`_start`/`_stream`/`_cancel` with `FakeExecutionStore`/`FakeExecutor` — compose with the auth hooks.

## Gotchas

- **Route order**: register batch routes (`/executions/cancel`, `/executions/terminate`) **before** `/executions/{execution_id}`, or the id route swallows them (FastAPI matches in registration order).
- **404, never 403**: id-addressed paths get `Depends(require_owned(ownership_name))` via `_mounter`; batch routes call `_require_all_owned` (ids in body, all-or-nothing). `ExecutionRoute` re-labels a platform 404 to `UNKNOWN_EXECUTION`; 429/503 still surface.
- **Create order**: `record → on_create → start` (ownership before start); `Idempotency-Key` folds ownership+claim into atomic `reserve_execution` scoped `(user, workflow, key)`; any create-window failure calls `discard`.
