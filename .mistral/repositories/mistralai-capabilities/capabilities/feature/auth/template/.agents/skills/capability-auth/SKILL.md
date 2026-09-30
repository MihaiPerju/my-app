---
name: capability-auth
description: The app's authentication domain — a selector that ships no code of its own: it pulls Postgres for the user store, declares the gateway/Keycloak secrets, and arms the hidden `fastapi-auth` gate plus the `docker-compose-auth`/`helm-auth`/`k3d-auth` deployment overlays that carry the real identity code. Use when a protected route returns 401/403, when changing how the gateway-asserted caller is trusted, when locating which integration owns the gate, gateway, or Keycloak, or when wiring auth across a framework or deployment target.
---

# Authentication

The app's identity **domain** — and a pure selector. This capability's `template/` ships only this
skill; it owns no runtime code. Selecting `auth` does three things: it pulls `postgres` (a dependency)
for the user store, declares the gateway/Keycloak deployment secrets, and **arms the hidden `*-auth`
integrations** that ship the concrete identity gate, edge gateway, and Keycloak. To change auth
behaviour you edit one of those integrations, not this capability.

## The concrete edges live in hidden integrations, keyed by what else is selected

Each integration fires on `allOf` its two capabilities; without the partner, that surface is simply
absent. `auth` is the common half of every pair.

| Both selected            | Integration           | Ships (owned there, not here)                                                                                                                     |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastapi` + `auth`       | `fastapi-auth`        | The `require_user` gate and `Identity`/`User`/`UserStore` seam, the `PostgresUserStore` adapter `apps/api` mounts, and the authenticated `apps/api/src/api/routers/api/v1/` package. |
| `docker-compose` + `auth`| `docker-compose-auth` | The APISIX edge-gateway compose root (`deploy/compose/compose.gateway.yaml`), its image and data-plane config (`deploy/docker/gateway/`), and the dev Keycloak realm (`deploy/docker/keycloak/realm.json`). |
| `helm` + `auth`          | `helm-auth`           | The umbrella chart's edge-auth templates: the standalone APISIX gateway (`gateway-*.yaml`), the edge `ingress.yaml`, the OIDC issuer/clientId helper (`_gateway.tpl`), and the fail-closed auth preflight (`_validate.tpl`). |
| `k3d` + `auth`           | `k3d-auth`            | The local-cluster dev Keycloak — Deployment/Service plus the gateway→Keycloak egress NetworkPolicy (`deploy/k3d/keycloak.yaml`) — and its realm import (`deploy/k3d/realm.json`). |

`k3d` itself depends on `auth`, so `k3d-auth` always co-activates with a k3d selection; the other
three appear only when their framework or deployment partner is also selected.

## Gateway-asserted identity is the load-bearing decision

The app authenticates nobody. The edge gateway validates the caller against Keycloak (OIDC) and
injects identity headers; `require_user` — a FastAPI **dependency**, not middleware — parses them,
`401`s when the assertion is missing, upserts the local user row through the `UserStore`, and `403`s
an inactive one. Those headers are trustworthy only because the gateway strips any client-supplied
copy and the API is reachable only through it, so keep every direct API listener on loopback or an
internal network. This trust boundary is why `auth` pulls Postgres (the asserted caller is
persisted) and why the secrets it declares are the gateway's and Keycloak's.

The header *names* are configurable (via `env.identity`, defaulting to `x-user-id`/`x-user-email`) so
the app can sit behind a gateway that uses a different convention. The user store is a `Protocol`
resolved through FastAPI `dependency_overrides`; the host must install `PostgresUserStore` or the
gate fails loudly at first use — which is what keeps `db` out of the delivery layer's import graph.

## Does this belong in auth?

`auth` holds the identity contract and the deployment secrets, nothing executable. A change to how a
caller is gated, how the gateway is deployed, or how Keycloak is seeded lands in the integration
keyed to the framework or deployment target above. This capability earns a file only for a piece of
auth config that is genuinely both framework- and deployment-agnostic — rare enough that the default
answer is the integration, not here.
