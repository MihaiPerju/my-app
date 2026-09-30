---
name: capability-fastapi-auth
description: The app's edge-auth gate — the gateway-asserted `require_user` dependency, the `UserStore` Protocol seam with its `PostgresUserStore` binding, and the authenticated `/api/v1` mount. Use when a route unexpectedly 401s or 403s (or must stay anonymous), when wiring or swapping the user store, when changing the gateway identity headers, or when deciding whether a new route group inherits the gate.
---

# FastAPI Auth

The FastAPI × auth seam: turn the caller the gateway asserts into an active local user row and refuse
everything else. Hidden — activates when both `fastapi` and `auth` are effective. Owns the
`require_user` gate, the `UserStore` Protocol + `PostgresUserStore` adapter, and the authenticated
`/api/v1` router. Defers to `auth` (APISIX+Keycloak gateway), `capability-fastapi` (host +
hook/file-router machinery), `db` (users table/model/accessor), and `fastapi-workflows-auth`
(per-execution ownership).

## Where things live

| Path | What |
| --- | --- |
| `mistralai_capabilities.fastapi_auth.identity` | Installed toolkit; the gate, imports no `db`. `gate.py`=`require_user`+`CurrentUser`+bearer scheme; `headers.py`=`parse_identity`,`Identity`,`HEADER_USER_ID/EMAIL`; `store.py`=`UserStore` Protocol,`_user_store`,`Users`; `user.py`=structural `User`(`user_id`,`is_active`). |
| `mistralai_capabilities.fastapi_auth.stores` | `PostgresUserStore`+`install_user_store`; the one `db` importer. |
| `apps/api/src/api/configure/auth.py` | `configure = install_user_store`; app-local hook run at construction. |
| `apps/api/src/api/routers/api/v1/__init__.py` | Authenticated mount; `dependencies=(Depends(require_user),)` cascades to all nested modules. |
| `packages/py/env/src/env/identity.py` | `env.identity`; gateway header names (defaults `x-user-id`/`x-user-email`). |
| `apps/api/tests/test_auth.py`, `tests/support/auth.py` | Suite + `FakeUserStore`/`auth_headers`/`auth_hooks` (swap via `dependency_overrides[_user_store]`). |
| `ts` pkg `@mistralai-capabilities/feature-fastapi-auth` | Manifest carrier only (`export type … = never`). |

## Extend

- **Gate a new route group:** put it under `v1/` — it inherits the gate. Need the caller? annotate `CurrentUser` (`Annotated[User, Depends(require_user)]`), cached per-request. Anonymous routes go in `routers.internal` (empty rule), never under `v1/`.
- **Swap the user store:** implement `UserStore.upsert`; bind via `dependency_overrides[_user_store]` at construction. Prod: `install_user_store(app)`→`PostgresUserStore`. Tests: `auth_hooks(FakeUserStore())` (assert `.seen`, flip `.is_active`).
- **Add host wiring:** drop `configure/<name>.py` exporting a `configure` callable; the host auto-discovers and runs it at construction — don't edit `create_app`.
- **Retarget gateway headers:** set `IDENTITY_HEADER_USER_ID`/`IDENTITY_HEADER_USER_EMAIL` (resolved + lower-cased once at import); don't edit `headers.py`.

## Gotchas

- No assertion → `401` + `WWW-Authenticate: Bearer` (triggers MCP OAuth); asserted-but-inactive → `403 User is not active`. Every request upserts, so deactivation takes effect next request. Blank header = absent; a bearer token alone is not identity (gateway consumes `Authorization`).
- `_user_store` raises `RuntimeError` until bound (forgotten wire fails loudly). Never import `stores` from the rest of the delivery layer or a worker — keeps `fastapi_auth → db` one-way and acyclic.
