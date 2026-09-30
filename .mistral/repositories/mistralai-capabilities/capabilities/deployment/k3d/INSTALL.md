# Install — `@mistralai-capabilities/k3d`

Adds a local Kubernetes workflow that deploys the `helm` umbrella chart to a k3d cluster and checks
it serves the API (and, with `tanstack-start`, a login).

## Prerequisites

- Sibling capabilities: `helm`, `fastapi`, and `auth` (added automatically, with their own
  dependencies).
- `k3d`, `kubectl`, `helm`, `docker`, `python3`, and `curl`.
- `MISTRAL_API_KEY` must be set; `k3d:up` exits before creating the cluster without it.
- `MISTRAL_REGISTRY_TOKEN` when building images that pull from an authenticated package index.

## Install

```bash
mistral apps capability add k3d
bunx nx run k3d:up     # create the cluster, deploy the chart, run the smoke checks
```

Verify: `k3d:up` fails unless `/api/health` on `http://localhost:8080` (override with `K3D_APP_PORT`)
returns 200 (and, with `tanstack-start`, `/` redirects to Keycloak). Tear down with
`bunx nx run k3d:down`.

- Log in as `dev` / `dev`; Keycloak is at `http://localhost:8082`. The ports do not clash with the
  Compose stack, so both can run at once.
