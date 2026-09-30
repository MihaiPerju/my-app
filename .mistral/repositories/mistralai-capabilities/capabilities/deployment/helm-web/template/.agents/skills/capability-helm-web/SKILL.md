---
name: capability-helm-web
description: The web host's Helm subchart at `deploy/helm/app/charts/web` — a thin adapter that renders the TanStack Start SSR Deployment, Service, and HPA through the shared `common` library chart, shipped `enabled: false` until the umbrella turns it on. Use when the web pod will not start or scale in-cluster, when changing the web image, container port, replicas, or autoscaling, or when the subchart renders no manifests.
---

# Helm — Web

In-cluster deployment adapter for the **web** host — the Helm subchart at
`deploy/helm/app/charts/web` that renders the TanStack Start SSR service as a Kubernetes Deployment,
Service, and HPA. Owns the **subchart only** (`web` config values + three thin template wrappers);
defers app code to `tanstack-start`, the manifest shapes to the sibling `common` library chart, and
umbrella wiring to `helm`.

## Where things live

| Path | What |
| --- | --- |
| `deploy/helm/app/charts/web/Chart.yaml` | Subchart metadata; declares dependency on sibling `common` (`file://../common`). |
| `deploy/helm/app/charts/web/values.yaml` | Whole config surface — `enabled` gate, image, ports, env, resources, writable mounts, probes, autoscaling. Ships `enabled: false`. |
| `deploy/helm/app/charts/web/templates/deployment.yaml` | Guarded `include "common.deployment"`, `component "web"`. |
| `deploy/helm/app/charts/web/templates/service.yaml` | Guarded `include "common.service"` — `ClusterIP` on 3001. |
| `deploy/helm/app/charts/web/templates/hpa.yaml` | Guarded `include "common.hpa"`; renders only when `enabled` **and** `autoscaling.enabled`. |

## Extend

Each `templates/*.yaml` is a `{{- if .Values.enabled }}` guard plus one `include "common.<kind>"`
passing `dict "root" . "component" "web" "workload" .Values`; the subchart defines **no manifest
structure of its own**.
- Change the web pod's *config* (image, ports, resources, replicas) → `values.yaml` here.
- Change the *shape* every host renders (labels, volume wiring, security-context) → `common`, not here.
- **Image** `docker/solutions/<app>-web` (app name baked from `.hbs` at generation); `tag`/`pullPolicy` empty so the umbrella's globals supply them.
- **Ports** `containerPort`/`service.port`/`env.PORT` must all be 3001; `env.HOST: 0.0.0.0` binds in-cluster, `env.NODE_ENV: production`. `ClusterIP` — gateway routes to it.
- **Autoscaling** 2–8 replicas at 75% CPU, `replicaCount: 2` matches `minReplicas`.
- **Writable mounts** `writableVolumes` gives emptyDir at `/tmp` + `/home/node/.cache`; extend if the server writes elsewhere.
- **Pass-throughs** `command`/`args` empty; `podSecurityContext`/`containerSecurityContext`/`nodeSelector`/`tolerations`/`affinity`/`podAnnotations` are empty override hooks consumed by `common`.

## Gotchas

- Umbrella flips `web.enabled: true` only when `tanstack-start` is selected; capability is hidden + auto-activates `allOf [helm, tanstack-start]`. No web pod from `helm install` → umbrella didn't set `web.enabled`.
- Probes hit `GET /`; if the SSR root doesn't return 200 the pod never goes ready.
