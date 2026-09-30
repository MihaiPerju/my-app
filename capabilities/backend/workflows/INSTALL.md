# Install — `@mistralai-capabilities/backend-workflows`

Adds the app's durable worker: a uv project at `apps/worker` that discovers the workflow classes
under `apps/worker/src/worker/workflows/` and serves them. It binds no port.

## Prerequisites

- **Sibling capabilities** — `core` (supplies `MISTRAL_API_KEY`).
- **Services** — the hosted Mistral workflows platform at `WORKFLOWS_BASE_URL`; the worker connects
  out to it, so there is no Temporal server to run.
- **`WORKFLOWS_ENCRYPTION_KEY`** — the seeded key is public and for local development only. For any
  shared or deployed environment, generate your own:
  `python -c 'from cryptography.hazmat.primitives.ciphers.aead import AESGCM; print(AESGCM.generate_key(bit_length=256).hex())'`.
- **`DEPLOYMENT_NAME`** — names the task queue and defaults to a per-user value. `{{env:USER}}`
  expands to empty where `USER` is unset (CI, containers), so set `USER` or edit `DEPLOYMENT_NAME`
  there to avoid sharing a queue.
- Do not set an `AGENT` environment variable: the workflows SDK reads it at import and breaks.

## Install

```bash
mistral apps capability add workflows
bun run install-all
```

Verify: `bunx nx run worker:serve` starts the worker with hot reload and connects to the platform.

Managed deployment is `mistral apps deploy` from the app root, after pushing the commit. The worker
module is marked `"platform": "workflows"`, so it deploys as a managed workflow deployment named
`<app>-<module>`, and the app's other modules get `DEPLOYMENT_NAME` set to that name. A dependency on
the private `mistralai` index needs registry secrets bound on the deployment, and the skill's managed
deployments guide has the steps. To dispatch to it with `workflow-start`, set `DEPLOYMENT_NAME` to
`<app>-<module>`.

## Environment reference

| Variable                               | Default                                |
| -------------------------------------- | -------------------------------------- |
| `DEPLOYMENT_NAME`                      | `deployment-{{app_name}}-{{env:USER}}` |
| `WORKFLOWS_BASE_URL`                   | `https://api.mistral.ai`               |
| `WORKFLOWS_ENCRYPTION_MODE`            | `partial` (`off`, `partial` or `full`) |
| `WORKFLOWS_ENCRYPTION_KEY`             | public local-development key           |
| `WORKFLOWS_ENCRYPTION_PREVIOUS_KEY`    | empty; decrypt-only, for key rotation  |
| `ACTIVITY_READ_RETRY_MAX_ATTEMPTS`     | `3`                                    |
| `ACTIVITY_MUTATION_RETRY_MAX_ATTEMPTS` | `1`                                    |
| `ACTIVITY_RETRY_BACKOFF_COEFFICIENT`   | `2.0`                                  |
