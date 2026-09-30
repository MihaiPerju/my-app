---
name: capability-helm-auth
description: The umbrella Helm chart's edge-authentication overlay — the standalone APISIX gateway (Deployment, Service, ConfigMap), the OIDC issuer/clientId helpers, the fail-closed auth preflight, and the edge Ingress that always routes through the gateway. Use when editing the APISIX routes or the identity-header injection, when the gateway or ingress will not render, when wiring `auth.oidc.*` or the OIDC/session secret keys, or when changing how the edge authenticates traffic before it reaches api and web.
---

# Helm — Auth

Edge-authentication half of the Helm deploy: a standalone APISIX gateway that drives OIDC, strips caller identity headers, and injects the `x-user-id`/`x-user-email` the API trusts. Owns only the six chart templates below; the umbrella chart (`Chart.yaml`, `values.yaml`, `common.*` subchart, secret delivery, netpol) belongs to `helm`, and the app-side gate (`require_user`) + compose/dev gateway to `auth`. Hidden overlay: vendored only when both are effective (`activatedWhen: allOf [helm, auth]`).

## Where things live

| Path (`deploy/helm/app/templates/`) | What |
| --- | --- |
| `gateway-deployment.yaml` | APISIX data-plane Deployment: `copy-conf` init container, read-only rootfs + in-memory temp mounts, OIDC client + session secrets via `secretKeyRef`. |
| `gateway-service.yaml` | Gateway `ClusterIP` Service. |
| `gateway-configmap.yaml` | APISIX `config.yaml` (admin off) + `apisix.yaml`: route table, `openid-connect` plugin, identity-header Lua. |
| `_gateway.tpl` | `gateway.oidc.issuerUrl`/`clientId` helpers, falling back to `ingress.oidc.*`. |
| `_validate.tpl` | `common.validateAuth`, the fail-closed preflight. |
| `ingress.yaml` | Edge Ingress; both `/api` and `/` target the gateway Service. |

Enable keys (`gateway.enabled`, `ingress.enabled`, `auth.oidc.*`, the `oidc-client-secret`/`gateway-session-secret` keys) come from the `helm` capability's `values.yaml` under `{{#if (has "auth")}}`; every template guards on them, so the whole edge appears or vanishes together.

## Add / change an APISIX route

Edit `apisix.yaml` inside `gateway-configmap.yaml`, mirroring the compose twin `deploy/docker/gateway/apisix.yaml` (carries the rationale):
- Public routes need no plugin; protected routes run `openid-connect` (`bearer_only: false` serves browser + API on one route; `/mcp` uses `true`, gated on `global.api.mcpAppsEnabled`). Validate via `introspection_endpoint`, not `use_jwks` (Keycloak's `iss` varies by URL).
- On protected `/api`/`/mcp`, a `serverless-pre-function` sets `X-User-Id`/`X-User-Email` from the base64 `X-Userinfo` and strips `X-Userinfo`/`X-ID-Token`/`X-Refresh-Token`/`Authorization`; missing/malformed userinfo → 401. Web `/*` authenticates + strips but injects nothing (it reads its own session cookie).
- `OIDC_CLIENT_SECRET`/`GATEWAY_SESSION_SECRET` reach the pod as env from the chart Secret, referenced via `$env://`. New writable path → add an in-memory `emptyDir` (rootfs is read-only); the `checksum/config` annotation auto-rolls the Deployment on ConfigMap change.

## Gotchas

- Header hygiene: every `proxy-rewrite` `remove`s caller `x-user-id`/`x-user-email`; never name a header in both `remove` and `set` (APISIX 3.17 runs add→set→remove, remove wins), never `remove` `X-Userinfo` (injection Lua needs it), never add kubelet probe paths as routes.
- `common.validateAuth` `fail`s the render when `ingress.enabled` && `!gateway.enabled` or when the session key equals the client-secret key; it must be `include`d from a rendered manifest (Helm never runs a bare `_`-partial's top level).
- `ingress.yaml` writes `oidc-issuer`/`oidc-client-id` from `ingress.oidc.*` with **no** fallback to `auth.oidc.*` — keep both populated with equal values or gateway and ingress diverge. `copy-conf` uses `cp -R`, never `cp -a` (EPERM as uid 1000).
