---
name: capability-apps
description: Deployment to the Mistral Apps platform, the default for a new app. A gateway in front of the app puts a short-lived per-caller token on each request; this capability supplies it to `utils.mistral` as the credential a caller's Mistral API calls spend, so work is billed and authorised as the caller, not the app key. Use when a route should act as its caller, when wiring or debugging the gateway token, the credential fallback, or the `apps-fastapi` mount, or when deciding whether behaviour is caller-billing (here) vs identity gating (`auth`).
---

# Mistral Apps

Deployment to the Mistral Apps platform — the default choice for a new app, contributing **no orchestration files** (the platform builds and runs the app itself). It owns the gateway seam: the short-lived per-caller token the gateway puts on each request, plus the wiring that makes it the credential a caller's Mistral API calls spend. Defers the FastAPI mount to the hidden `apps-fastapi` integration and the Mistral client to `core` (`utils.mistral`). Unlike `auth` (the identity gate — *who* is calling), this decides *whose* token a call spends; `package/ts` is a carrier only (`DeploymentAppsCapability = never`).

## Where things live

| Path | What |
| --- | --- |
| `mistralai_capabilities.apps.tokens` | `TOKEN_HEADERS` (`x-apps-token`/`x-space-token`), `token_from(headers)`, `bound_token()` ctxmgr, `current_token()` — a contextvar, no web framework. |
| `mistralai_capabilities.apps.middleware` | `GatewayTokenMiddleware`: plain ASGI (not `BaseHTTPMiddleware`), binds the token in the route's own task. Imports starlette. |
| `mistralai_capabilities.apps.credentials` | `install_gateway_credentials(app)` + `caller_credentials_via(proxy_url)` — the one place naming `utils.mistral`. No-ops when no proxy URL. Imports fastapi. |
| `packages/py/env/src/env/gateway.py` | Vendored `env.gateway`: `apps_proxy_url` from `__APPS_PROXY_URL`/`__SPACES_PROXY_URL`, platform-injected, never in the generated `.env`. |

The toolkit's `[fastapi]` extra pulls `fastapi`/`starlette`; importing the package top-level pulls in neither `credentials` nor `middleware`.

## Extend

- **Act as the caller off HTTP:** call `current_token()` — set for any task the middleware wrapped, no framework needed.
- **Mount on another host:** call `install_gateway_credentials(app)` at construction; the hidden `apps-fastapi` integration already does this for FastAPI via `apps/api/src/api/configure/gateway_token.py` (`configure = install_gateway_credentials`), firing when both `apps` and `fastapi` are effective.
- **Relocate the API / add a proxy alias:** edit the vendored `env.gateway` `AliasChoices`.

## Gotchas

- No proxy URL → nothing installed, every call falls back to `MISTRAL_API_KEY` (`mistral apps dev --no-gateway`, bare uvicorn, tests, direct Helm/Compose).
- Proxy URL set but a request carries no token → `MistralNotConfiguredError`; caller-less work must build its own client on `MISTRAL_API_KEY`.
- Not an identity gate — that is `auth`; this only decides whose token a Mistral call spends.
