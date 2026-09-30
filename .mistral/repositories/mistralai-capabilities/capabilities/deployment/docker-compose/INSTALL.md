# Install — `docker-compose`

Adds a local Docker Compose deployment: the Compose roots, the initialization image, a smoke-test
runbook, and the `compose` Nx tasks. Service overlays for the API, web, workflows, Postgres, Bucket,
and the auth gateway are added automatically for whichever of those capabilities are selected.

## Prerequisites

- Sibling capabilities: `core`.
- Docker with the Compose plugin.
- `MISTRAL_REGISTRY_TOKEN` (exported, or in `.env.registry`) when building images that pull from an
  authenticated package index; `compose:smoke` requires it unless `SKIP_BUILD=1`.
- Host ports (`API_PORT`, `WEB_PORT`, `POSTGRES_PORT`, `GATEWAY_PORT`, ...) and an optional
  `COMPOSE_PROJECT_NAME` are read from the app's root `.env`.

## Install

```bash
mistral apps capability add docker-compose
bunx nx run compose:up     # build and start the stack; init steps (migrations, ...) run on every up
```

Verify with `bunx nx run compose:smoke`: it starts its own stack on the same host ports, reports
PASS / FAIL / SKIP per check, and tears it down (`KEEP_UP=1` keeps it), so run `compose:down` first.
Other targets: `dev` / `dev-down` (hot-reload stack), `logs`, `down`, `build-images`, and `init`
(re-runs the init steps on the host).

- Without `auth`, the stack has no gateway in front of the API. Never expose an API that trusts
  gateway identity headers without a gateway that authenticates every request and strips
  client-supplied copies of those headers.
