# Install — `@mistralai-capabilities/helm`

Adds a Kubernetes deployment: the umbrella Helm chart at `deploy/helm/app` (with `common` library and
initialization charts) and a `helm:validate` task. Subcharts for the API, web, workflows, Postgres,
and the auth gateway and ingress are added automatically for whichever of those capabilities are
selected.

## Prerequisites

- Sibling capabilities: `core`.
- `helm` and `kubeconform`, used by `helm:validate`.
- With `postgres`: a managed Postgres URL in the chart value `secrets.data.database-url`, or
  `global.postgres.deploy: true` to run Postgres in-cluster (dev and preview only).

## Install

```bash
mistral apps capability add helm
```

Verify with `bunx nx run helm:validate`, which lints and renders the chart and validates every
manifest.
