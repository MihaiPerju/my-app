---
name: capability-helm-workflows
description: The app's in-cluster workflow-worker Helm subchart at `deploy/helm/app/charts/workflows` — a thin adapter that deploys the Workflow SDK worker (no Service, no Ingress) by delegating render to the shared `common` chart. Use when the worker will not deploy in-cluster, when changing its image/command/env or resources for Helm, when tuning worker autoscaling or replicas, or when reasoning about the `workflows.enabled` gate the umbrella flips.
---

# Helm — Workflows

The `workflows` subchart of the umbrella chart at `deploy/helm/app`: deploys the headless Workflow SDK
worker (`apps/worker` host — no `Service`, no `Ingress`) into a cluster. Owns the **subchart adapter
only** (per-component values + two thin template stubs); Pod/probe/HPA render logic lives in the
sibling `common` library chart (owned by `helm`), the worker code in the `workflows` capability.
Hidden overlay (`visible: false`) — auto-activates when both `helm` and `workflows` are effective
(`activatedWhen.allOf: [helm, workflows]`).

## Where things live

| Path (`deploy/helm/app/charts/workflows/`) | What |
| --- | --- |
| `Chart.yaml` | Subchart manifest (`name: workflows`); one dep, the `common` library chart (`file://../common`). |
| `values.yaml` | Per-component values: worker image, command, env, resources, `enabled: false` gate, off-by-default CPU HPA. |
| `templates/deployment.yaml` | Worker Deployment — one-line `include "common.deployment"` guarded by `.Values.enabled`. |
| `templates/hpa.yaml` | Optional CPU HPA — `include "common.hpa"` guarded by `.Values.enabled` **and** `.Values.autoscaling.enabled`. |

## Extend

- Change what the worker **is** (image, command, env, resources) → edit `values.yaml`. Image is the
  shared `docker/solutions/<app>-python`, `tag`/`pullPolicy` blank.
- Change how it renders (probes, labels, volumes) → edit `common`; both stubs pass
  `component: "workflows"`, `workload: .Values`.
- Deploy gate: umbrella flips `workflows.enabled: true` when the capability is selected; HPA needs
  `.Values.enabled` **and** `.Values.autoscaling.enabled`.
- Worker cmd: `uv run --frozen --no-dev --no-sync --directory apps/worker python -m worker.entrypoints.worker`;
  `ports.enabled: false`, `/tmp` its one `writableVolumes` mount.

## Gotchas

- `HOME=/tmp` is load-bearing — the Agents SDK (`nuage_v2`) plugin's `vibe` dep writes `~/.vibe` at import.
- `OTEL_ENABLED=false` keeps tracing opt-in; umbrella overrides to `true` when Observability is selected.
- `autoscaling.enabled: false` — workers scale on queue backlog, not CPU; prefer `replicaCount`, enable the CPU HPA only when CPU-bound.
