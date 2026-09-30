---
name: capability-helm
description: The app's optional Kubernetes deployment — the umbrella Helm chart, the `common` library chart, the init hook-Job chart, and the parent-owned Secret / NetworkPolicy / ServiceAccount / ExternalSecret templates. Service subcharts and the APISIX gateway are hidden `helm-*` integrations, not here. Use when `helm:validate` (`tools/validate-helm.sh`) fails, when adding or reordering a deployment init step, when touching the shared `common.*` helpers every workload includes, when wiring the umbrella's secrets / network policy / service account, or when a gateway, ingress, or service subchart is missing because its integration is inactive.
---

# Helm

The app's optional, **template-only** in-cluster deployment (no Python/TS/package). Owns the **shared** Helm infra — the umbrella chart skeleton, the `common` library chart, the deployment-`init` chart, the parent-owned secret/network/identity templates, and the `validate` task. Per-service subcharts (`api`/`web`/`workflows`/`postgres`) and the APISIX gateway are **not** here: each is a hidden `helm-*` integration (`helm-api`/`helm-web`/`helm-workflows`/`helm-postgres`/`helm-auth`) that vendors its subchart only when Helm + its service capability are both effective. Opt-in: an unselected app ships no chart or `helm:validate`.

## Where things live

| Path | What |
| --- | --- |
| `deploy/helm/app/Chart.yaml` | Umbrella; always deps `common`+`init`; each service subchart dep gated by the **same** `has "<service>"` condition that vendors it → never a dangling `file://`. |
| `deploy/helm/app/values.yaml` | Defaults + single source for `global.*` (image/security/secrets/postgres/ingress/ports) merged into every subchart; parent resource blocks; auth-gated `gateway`/`ingress`/`auth` blocks (templates consuming them belong to `helm-auth`). |
| `deploy/helm/app/values-production.yaml` | Prod overlay (ExternalSecrets, managed Postgres, replica/HPA) — the second profile validated. |
| `deploy/helm/app/templates/*.yaml` | Parent-owned: `secret.yaml` (Opaque from `secrets.data`; preserves/generates in-cluster PG password), `externalsecret.yaml`, `registry-secret.yaml`, `serviceaccount.yaml`, `networkpolicy.yaml`, `NOTES.txt`. |
| `deploy/helm/app/charts/common/` | Library chart: `common.*` named templates (naming/labels, image, security-context, secret/env helpers) + generic `_deployment`/`_service`/`_job`/`_hpa`/`_probes`. |
| `deploy/helm/app/charts/init/` | `values.yaml` lists `steps:`; `templates/job.yaml` renders one hook Job per step via `common.job`. |
| `tools/validate-helm.sh`, `tasks/helm/project.json` | `bunx nx run helm:validate` → lints + renders both value profiles through strict `kubeconform` (missing CRD schemas skipped). |
| `tests/test_helm_init.py`, `test_helm_tasks.py`, `test_drain_contract.py` | Guard chart steps↔vendored `cli` commands, the validate target/chart presence, the api preStop drain path. |
| `deploy/helm/README.md`, `.github/workflows/helm.yml` | Operator runbook; CI runs `validate-helm.sh` on PR + push to `main`. |

## Extend

- **Shared workload behavior** → edit `charts/common/templates/_*.tpl` once (a subchart is one `{{ include "common.deployment" (dict "root" $ "component" "api" "workload" .Values) }}`). Names derive from `.Release.Name` via `common.fullname` (**not** `.Chart.Name`); env via `common.extraEnv` → `databaseEnv`/`mistralSecretEnv`/`vibeAgentsEnv`/`connectorSecretEnv`, every secret var `secretKeyRef`.
- **Deployment init step** → add `packages/py/cli/src/cli/commands/<step>.py` (runs `python -m cli <step>` from the API image) + a `{name, hookWeight}` entry in `charts/init/values.yaml` (lowest weight first, after its deps, idempotent). Steps are capability-gated (`migrations`←postgres, `guardrail`←guardrailing, `prompts`←agents, `agents`←chat, `schedules`←evals); `test_helm_init.py` fails if a `steps:` entry names a command the app didn't vendor.
- **Parent secret/policy/identity** → edit `templates/*.yaml`; NetworkPolicy is default-deny with allows derived defensively via `(.Values.x).enabled`, and its PG allow-list comes from `init.steps` (a new step is auto-admitted).
- **Anything api/web/gateway-specific** → NOT here; add it to the owning `helm-*` integration. Only service-agnostic shared infra lives here.
- After any change: `bunx nx run helm:validate` (or `bash tools/validate-helm.sh`).

## Gotchas

- Init Jobs are `post-install,pre-upgrade` hooks (**not** `pre-install` — a pre-install pod runs before its ServiceAccount/Secret/DB exist). `hookWeight` is validated `^-?[0-9]+$` and quoted (Helm's `Atoi` silently falls back to weight 0).
- Secrets are referenced, never inlined (`secretKeyRef` only): a blank value is omitted so the var stays **off** the pod (consumers use `optional: true`), not set to `""`.
- Every workload is hardened by default (non-root uid/gid 1000, read-only rootfs, caps dropped, seccomp `RuntimeDefault`, requests+limits; `writableVolumes` → tmpfs). A Helm-only/auth-free app rendering no gateway/ingress/service subchart is correct, not a bug.
