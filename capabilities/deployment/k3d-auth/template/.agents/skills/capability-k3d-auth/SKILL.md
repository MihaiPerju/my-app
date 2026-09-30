---
name: capability-k3d-auth
description: The k3d cluster's dev Keycloak — the `start-dev --import-realm` Deployment, its NodePort Service and gateway→Keycloak egress NetworkPolicy (`deploy/k3d/keycloak.yaml`), and the realm import (`deploy/k3d/realm.json`) that `k3d-up` retargets and applies before the umbrella chart. Use when a k3d login fails or a token reads "invalid", when changing the realm's clients/roles/dev user, when the gateway cannot reach Keycloak in-cluster, or when the browser cannot hit the login redirect.
---

# k3d — Auth

Raw Keycloak manifests the k3d run applies with `kubectl` **before** the umbrella Helm chart: the dev Keycloak Deployment/Service, the gateway→Keycloak egress NetworkPolicy, and the realm import. Owns only these identity pieces; defers the run driver to `k3d` (`tools/k3d-up.sh`, `deploy/k3d/values-local.yaml`, `k3d` NX tasks), the gateway/parent chart to `helm-auth`, compose Keycloak+realm to `docker-compose-auth`, the in-app gate + Postgres store to `fastapi-auth`, and auth env/secrets to the `auth` feature. Hidden, gated `allOf: [k3d, auth]`; `k3d`→`auth`, so any k3d run pulls it in.

## Where things live

| Path | What |
| --- | --- |
| `deploy/k3d/keycloak.yaml` | Dev Keycloak: `start-dev --import-realm` Deployment, NodePort Service (host `8082`→node `31082`), `gateway-to-keycloak` egress NetworkPolicy. |
| `deploy/k3d/realm.json` | Realm `mistralai-capabilities`: confidential `app` client (secret `dev-client-secret`), roles `user`/`admin` (`user` default), audience (`aud: app`)/realm-role (`realm_access.roles`)/email mappers, `dev`/`dev` fixture user (`dev@mistral.ai`). |

## How k3d-up applies these

`tools/k3d-up.sh` (owned by `k3d`) wires both by hand before `helm upgrade --install`: reads `realm.json`, rewrites each client's `redirectUris`/`webOrigins` from the compose port (`9080`) to `http://localhost:${K3D_APP_PORT:-8080}` → `/tmp/realm-k3d.json`, creates ConfigMap `keycloak-realm`, `kubectl apply`s `keycloak.yaml`, waits for `deploy/keycloak`. So `redirectUris`/`webOrigins` are compose defaults overwritten at apply time; everything else in `realm.json` imports verbatim (readiness probe hits `/realms/mistralai-capabilities`, so a ready pod proves the import landed).

## Extend

- **Realm clients/roles/mappers/user** — edit `realm.json`; imports verbatim.
- **Compose redirect target** — edit `redirectUris`/`webOrigins` (the k3d value follows `K3D_APP_PORT`).
- **`app` client secret** — update `realm.json` `secret` AND `deploy/k3d/values-local.yaml` (`secrets.data.oidc-client-secret`); `k3d-up.sh` installs with `-f values-local.yaml` and never forwards `GATEWAY_OIDC_CLIENT_SECRET`. Change one, change both, or introspection fails.

## Gotchas

- **One issuer.** `KC_HOSTNAME=http://localhost:8082` pins `iss` to the browser URL; `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` lets the gateway's in-cluster `keycloak:8080` introspection resolve. Drop `KC_HOSTNAME` → issuer floats, introspection returns `active:false`, login fails "invalid token".
- **Two callers.** Browser hits Keycloak front-channel via NodePort `8082` (a `ClusterIP` would break the redirect); gateway introspects back-channel at `keycloak:8080` — `gateway-to-keycloak` re-opens the RFC1918 egress the parent chart's default excludes.
