---
name: capability-k3d
description: The optional local-Kubernetes workflow — stands the umbrella Helm chart up on a throwaway k3d cluster and proves the app serves a login (`tools/k3d-up.sh`, the `values-local.yaml` overlay, the `k3d:up`/`k3d:down` NX targets). Use when `k3d:up` cannot create the cluster or finish a rollout, when the `/api/health` or `/` login-redirect smoke check fails, when changing which runtimes get built and imported or the local values overlay, or when deciding whether something belongs here versus the `helm` chart or the hidden `k3d-auth` Keycloak resources.
---

# k3d

The optional local-Kubernetes workflow: stands the production umbrella Helm chart up on a throwaway k3d cluster and proves the app serves a login, catching the **runtime** failures `helm lint`/`kubeconform` can't see (hook order, read-only rootfs, a NetworkPolicy that drops the DB). Owns only the local-cluster lifecycle + values overlay; **reuses** `helm`'s chart at `deploy/helm/app` (ships no chart/Dockerfile/app source), and deploys Keycloak from the hidden `k3d-auth` overlay.

## Where things live

| Path | What |
| --- | --- |
| `tools/k3d-up.sh` | Up pipeline: create cluster, install ingress-nginx, build + import runtime images, apply Keycloak, `helm upgrade --install` the umbrella chart, wait on rollouts, smoke-test. |
| `tools/k3d-down.sh` | Deletes the cluster (`K3D_CLUSTER`, default `scapp`); leaves the Compose stack alone. |
| `deploy/k3d/values-local.yaml` | Local values overlay for the umbrella chart — one per-subchart override block per selected module. |
| `tasks/k3d/project.json` | `k3d` NX project: `up`/`down` targets (`bunx nx run k3d:up` / `k3d:down`). |
| `tests/test_k3d_tasks.py` | Contract test: NX targets wrap the scripts, assets land where helpers expect, k3d reuses helm's chart. |

## Add / change a runtime

Both `k3d-up.sh` and `values-local.yaml` use the same `has "…"` selection gates as the Helm chart and Compose, so the emitted shape matches the selected closure. To add a built runtime: add it to the `SERVICES` list in `k3d-up.sh` (maps service→prod build target, tags every image `app-<service>:runtime`) and add its `has "…"` gate + override block in `values-local.yaml`. `api` (`fastapi`) is always present (k3d depends on `fastapi`); only `web`/`tanstack-start` and its `/` redirect check are optional. Chart change → `helm`; Keycloak manifest/realm → `k3d-auth`; API runtime → `fastapi` — adding a chart/Dockerfile/adapter here duplicates what k3d reuses (`tests/test_k3d_tasks.py` guards it). Secrets: `mistral-api-key` is `--set-string` at install (never in the overlay), `postgres-password` is chart-generated, `oidc-client-secret`/`gateway-session-secret` are fixed dev values in the overlay.

## Gotchas

- **Images are side-loaded, never pulled**: overlay pins `registry: ""`, `tag: runtime`, `pullPolicy: Never`. The `:runtime` tag matters — `docker compose build` tags the `:latest` dev target (writable rootfs) which fails the chart's read-only rootfs. Import via explicit-platform `docker save`→tar (bare `k3d image import` emits attestation manifests k3d silently fails to load). Private images need auth: script sources `tools/uv.sh`, passes the token as the `registry_token` BuildKit secret.
- **Smoke test is the gate**, not just a deploy: `curl /api/health` must return `200`; with `web` in the closure `/` must redirect to the Keycloak realm — either failure calls `die`.
- **Ports/realm**: k3d owns `8080` (app) / `8082` (Keycloak, NodePort `31082`); the Compose dev stack owns `9080`/`8081`. Up script reads **only** `deploy/k3d/realm.json` (never Compose's), rewriting its redirect URIs to the local port.
