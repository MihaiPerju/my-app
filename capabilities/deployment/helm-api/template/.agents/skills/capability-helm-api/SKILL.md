---
name: capability-helm-api
description: The FastAPI `api` host's Helm subchart — the `api` adapter under the `app` umbrella that feeds API-specific values (image, probes, preStop drain, autoscaling) into the shared `common` templates. Use when api pods will not turn ready or keep restarting in a cluster, when tuning the startup/liveness/readiness probes or the graceful-drain window, when changing the api image/replicas/resources, or when wiring the HPA.
---

# Helm — API

The in-cluster deployment of the FastAPI `api` host: one Helm subchart at
`deploy/helm/app/charts/api/` rendering the API's Deployment, Service, and HPA. It owns the
**adapter only** — `Chart.yaml`, `values.yaml` (all API-specific tuning), and three thin templates
that delegate every manifest to the shared `common` library chart. It does NOT own `common` or the
`app` umbrella (both ship with `helm`), nor the `/api/health/*` endpoints it probes (owned by the API
host). Hidden integration: activates only when both `helm` and `fastapi` are effective.

## Where things live

| Path | What |
| --- | --- |
| `deploy/helm/app/charts/api/Chart.yaml` | Subchart identity (`name: api`); one dependency, `common` at `file://../common`. |
| `deploy/helm/app/charts/api/values.yaml` | Every API default: image `docker/solutions/<app>-api` (blank `tag`→global `image.tag`), `replicaCount`, port 3000, the three probes, preStop drain, resources, `/tmp` tmpfs. Ships `enabled: false`. |
| `.../templates/deployment.yaml` | Gates on `.Values.enabled`, `include`s `common.deployment` (`component: api`). |
| `.../templates/service.yaml` | `include`s `common.service` (ClusterIP on 3000). |
| `.../templates/hpa.yaml` | `include`s `common.hpa`, gated on `enabled` **and** `autoscaling.enabled`. |

## Extend

Each template is an adapter: gate on `.Values.enabled`, then `include` the matching `common.*`
passing `component "api"` and `workload .Values`.
- **Change what the API deploys** (image/replicas/probes/resources/drain) → edit `values.yaml` here.
- **Change a manifest's shape** → edit the `common` chart (shipped by `helm`), not these adapters.
- **Activation**: subchart ships `enabled: false`; the `app` umbrella sets `api.enabled: true` only
  when `fastapi` is selected, and all three templates open with `{{- if .Values.enabled }}`.

## Gotchas

- Probes hit distinct `/api/health/*` paths directly on the pod IP (never via APISIX — do NOT add
  them to gateway route lists or they land on the OIDC-protected `/api/*` route). Readiness
  `timeoutSeconds` (3s) must exceed db `_PING_TIMEOUT_S` (2.0s).
- Graceful drain: preStop `touch /tmp/drain && sleep 15` is a contract with
  `api/routers/api/internal/health.py::DRAIN_SENTINEL` (readiness→503). Keep
  `terminationGracePeriodSeconds: 45` = 15s preStop + 20s uvicorn graceful-shutdown + 10s margin.
