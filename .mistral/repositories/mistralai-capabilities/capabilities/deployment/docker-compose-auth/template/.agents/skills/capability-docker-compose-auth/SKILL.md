---
name: capability-docker-compose-auth
description: The Compose edge that authenticates the local stack — the `compose.gateway.yaml` root (APISIX gateway + dev Keycloak), the baked gateway image, the APISIX route/plugin config, and the dev realm import; the only component that validates identity and injects `x-user-id`. Use when a request 401s or 502s through the gateway (`${GATEWAY_PORT:-9080}`), when editing an APISIX route/OIDC plugin or the header-injection Lua, when changing the dev Keycloak realm, client secret, or fixture user, or when wiring same-origin browser traffic (`VITE_API_URL`/`CORS_ORIGIN`).
---

# Docker Compose — Auth

The authenticating edge of the local `docker compose` stack: APISIX gateway + dev Keycloak IdP + the OIDC config that puts a trusted `x-user-id` in front of the app. A **hidden integration** — activates when both `docker-compose` and `auth` are effective. Owns only the Compose-level edge; defers the auth domain/user records to `auth`, the in-app `require_user` gate to `fastapi-auth`, the Compose roots/init/smoke to parent `docker-compose`, and the K8s edge to `helm-auth`/`k3d-auth`.

## Where things live

| Path | What |
| --- | --- |
| `deploy/compose/compose.gateway.yaml` | Gateway Compose root: `gateway` (APISIX 3.17, host `${GATEWAY_PORT:-9080}`, container `9080`) + `keycloak` (`${KEYCLOAK_PORT:-8081}:8080`, `start_period: 300s`). Keycloak receives `GATEWAY_PORT` for the realm import. Parent roots `include` it when auth is effective. |
| `deploy/docker/gateway/apisix.yaml` | Route table + per-route plugin chain (OIDC + header rewrite + edge-auth Lua). Rendered from `.hbs`; routes gated per upstream; the web `/*` route sets `enable_websocket: true` so Vite HMR works through the gateway. |
| `deploy/docker/gateway/config.yaml` | APISIX static config: standalone `data_plane`, `yaml` provider (no etcd), Admin API off, `node_listen: 9080`. |
| `deploy/docker/Dockerfile.gateway` | Prod gateway image — bakes both configs into `apache/apisix:3.17.0-debian` (uid 1000); the alternative to Compose's read-only mounts. |
| `deploy/docker/keycloak/realm.json` | Dev realm import, rendered from `.hbs`: a realm named after the app (`{{projectName}}` at generation, the same value as `APP_NAME`), confidential `app` client whose redirect URIs, web origins and post-logout URIs are `http://localhost:${GATEWAY_PORT:9080}` (Keycloak resolves the placeholder at import), roles/mappers, `dev`/`dev` fixture user. |
| `deploy/compose/compose.api.auth.dev.yaml` | Dev overlay on `api`: `CORS_ORIGIN=http://localhost:${GATEWAY_PORT:-9080}`. |
| `deploy/compose/compose.web.auth{,.dev}.yaml` | Web overlays: `VITE_API_URL=""` — dev as runtime env, prod as `build.arg` — so the browser calls back same-origin through the gateway. |

## Add or change an authenticated route

Edit `apisix.yaml.hbs` (no Admin API — routes come from the YAML, not `PUT /apisix/admin`). Each authenticated route pairs three plugins, order load-bearing:
1. `openid-connect` — validate caller (cookie or bearer) vs `keycloak:8080`, set `X-Userinfo`.
2. `proxy-rewrite` — `remove` client-set `x-user-id`/`x-user-email` (spoof guard), set `X-Forwarded-*`.
3. `serverless-pre-function` (access) — edge-auth Lua: base64 `X-Userinfo`→JSON→`X-User-Id` (`sub`)/`X-User-Email` (`email`), then delete `X-Userinfo`/`X-ID-Token`/`X-Refresh-Token`/`Authorization`. Missing/malformed or no `sub` → `401 "Identity unavailable"`.

Gate the route (and the `gateway` `depends_on`) with `has "<toolkit>"` — an unvendored upstream 502s and Compose rejects a `depends_on` on an undefined service. Variants: `/api/health` prio 20 no-auth; `/api/*` prio 10 full OIDC (not `bearer_only`, `unauth_action: deny`); `/mcp`,`/mcp/*` (mcp-apps) `bearer_only: true`; `/*` prio 1 (tanstack-start) `set_userinfo_header: false`. Change the realm/client/`dev` user in `realm.json`, then recreate the keycloak container (it keeps no volume; import runs on an empty store). The realm name also appears in every `realms/<name>` URL of `apisix.yaml` and in `tools/smoke.sh`; rename all three together.

## Gotchas

- proxy-rewrite runs add→set→remove: never name a header in both `remove` and `set`, and never `remove` `X-Userinfo` (the Lua reads it first, then drops it) or every request 401s.
- Bearer tokens validate by **introspection, not `use_jwks`**; keep `KC_HOSTNAME=http://localhost:${KEYCLOAK_PORT:-8081}` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` or tokens introspect `active:false`.
- In `apisix.yaml.hbs`, `GATEWAY_OIDC_CLIENT_SECRET`/`GATEWAY_SESSION_SECRET` must stay `$\{{...}}` (backslash) or the rendered secret is empty. The realm's client `secret` is `${GATEWAY_OIDC_CLIENT_SECRET_JSON:dev-client-secret}`: Keycloak's entrypoint JSON-escapes `GATEWAY_OIDC_CLIENT_SECRET` (the gateway's variable) into it, because the import splices placeholders in as raw text. Keep that entrypoint when you change the Keycloak service. Healthchecks probe via bash `/dev/tcp` (image has no curl/wget).
