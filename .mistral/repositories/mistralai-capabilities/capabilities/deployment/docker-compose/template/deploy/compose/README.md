# deploy/compose/

Operator runbook for the Docker Compose stack: how deployment init is chained and extended, and
how to run and configure the end-to-end smoke test.

## Stack assembly

`docker compose` is pointed at one of two roots — `compose.yaml` (production) or `compose.dev.yaml`
(hot-reload development). Each root owns the shared infrastructure inline (the APISIX gateway and
Keycloak from `compose.gateway.yaml`, and the one-shot init chain from `compose.init.yaml`) and
`include:`s one overlay per deployed service:

| Overlay | Service | Present when |
| --- | --- | --- |
| `compose.api.yaml` / `compose.api.dev.yaml` | `api` | the API runtime is deployed |
| `compose.web.yaml` / `compose.web.dev.yaml` | `web` | the web frontend is deployed |
| `compose.workflows.yaml` / `compose.workflows.dev.yaml` | `workflows` | the durable worker is deployed |
| `compose.postgres.yaml` | `postgres` | Postgres is deployed |
| `compose.bucket.yaml` | `bucket` | the S3-compatible store is deployed (dev root) |

Each overlay is contributed by its own hidden `docker-compose-<service>` integration capability,
which becomes effective automatically when both Docker Compose and that service's capability are
selected. A root therefore `include:`s an overlay exactly when its service was generated, so the
stack never references a service file that is not present.

## Project name, ports, and the root `.env`

Drive the stack through `bunx nx run compose:<target>` (`tools/compose.sh`). It passes the root
`.env` to Compose with `--env-file`: Compose's project directory is `deploy/compose`, so a bare
`docker compose -f deploy/compose/compose.dev.yaml …` never reads that file. Add `--env-file .env`
yourself when you call Compose directly. Arguments after `--` reach `docker compose`
(`bunx nx run compose:dev -- --remove-orphans`).

The project is named after the app (`name:` in both roots), which namespaces every container,
volume, network and the `<project>-init:local` image, so two generated apps can run side by side.
`COMPOSE_PROJECT_NAME` (shell or root `.env`) overrides the name. Every host port is a root `.env`
variable; give the second app its own values:

| Var | Default | Publishes |
| --- | --- | --- |
| `GATEWAY_PORT` | `9080` | The APISIX gateway. Keycloak's redirect URIs and the API's CORS origin follow it. |
| `KEYCLOAK_PORT` | `8081` | Keycloak (and its issuer, `KC_HOSTNAME`). |
| `API_PORT` / `WEB_PORT` | `3000` / `3001` | The loopback-published api and web services. |
| `POSTGRES_PORT` | `5432` | Postgres. Move `DATABASE_URL` in `.env` with it for host-run processes. |
| `BUCKET_PORT` / `BUCKET_CONSOLE_PORT` | `9000` / `9001` | RustFS. Move `INGESTION_S3_ENDPOINT_URL` with it. |

`compose:dev` builds, then starts the stack. The dev containers keep their installed dependencies
(`/app/.venv`, `node_modules`) in anonymous volumes, and Compose hands the old volume to a rebuilt
container, so when the build changed an image it starts with `--renew-anon-volumes`. That recreates
every container, so it is skipped when nothing was rebuilt. It never removes orphans unless you
pass `--remove-orphans`.

## Deployment init (`python -m cli <step>`)

`compose.init.yaml` runs the one-shot deployment init as one **service per step**
(`python -m cli <step>` from the API image, which carries every workspace package). The steps are
chained in order with `depends_on` … `condition: service_completed_successfully`, and share build
and hardening config through the `x-init-step` anchor each service merges with `<<: *init-step`.

A no-op `init` gate service waits on the steps that gate the app (schema migrations, plus the
guardrail corpus and prompt registry when installed); that is the one name `compose.api.yaml` and
`compose.workflows.yaml` depend on, so they never name an individual step. `agents` and `schedules`
run *after* the worker (a registration binds to a workflow the worker must serve first), so they are
deliberately not behind the `init` gate.

Which services render depends on the selected capabilities — `init-migrations` (postgres),
`init-guardrail` (guardrailing), `init-prompts` (agents), `init-agents` (chat), `init-schedules`
(evals). Deselecting a capability drops its service here and its step in the Helm init chart. Every
step is idempotent, so the chain re-runs safely on every `up`.

```bash
bunx nx run compose:init               # every step locally, in order (dev convenience only)
bunx nx run worker:register-schedules  # just the schedules step
uv run python -m cli migrations
```

`bunx nx run compose:init` is a dev convenience and the only place the steps share a process; deploys always run
each step as its own service, never through it.

### Adding a step

Add a command module `packages/py/cli/src/cli/commands/<step>.py` following Typer's one-file-per-command
layout: it owns an `app = typer.Typer()` with a single `@app.command(name="<step>")` (put async work in
a sync command that calls `asyncio.run(...)`). `cli.main` discovers the module by filename and mounts its
app with `add_typer`, so it runs as `python -m cli <step>`; there is no manifest to hook into. The module
needs no `if __name__ == "__main__":` block and no `configure_logging(...)` call — the CLI configures
logging once in its Typer callback. A crash is a non-zero exit the platform reports. Put a step after
everything it depends on, and make it idempotent — init runs on every `up`.

Mark the module `INIT_STEP = True` and use **one name everywhere**: the module stem, the command
name, and the service suffix must be the same `<step>`, so `ontology_seed.py` registers
`name="ontology_seed"` and the service `init-ontology_seed` runs `python -m cli ontology_seed`.
`tests/test_compose_init_steps.py` compares the `INIT_STEP` module stems with the `init-<step>`
services, so a hyphenated command name (`ontology-seed`) in an `ontology_seed.py` fails it. A
one-word name (`seed`) avoids the question.

Then declare a service for it here: merge the `<<: *init-step` anchor and chain it in order with
`depends_on` … `condition: service_completed_successfully`, adding it behind the `init` gate when the
app must not start until it completes. If the Helm capability is also installed, add the matching
entry to its init subchart (`charts/init/values.yaml` `steps:` list, with a `hookWeight`); see
`deploy/helm/README.md`. Where a step belongs in the order is a deployment decision, so each runbook
owns its own ordering.

## smoke.sh — end-to-end smoke test

`tools/smoke.sh` brings up the full Compose stack and verifies it end-to-end with a per-check
**PASS / FAIL / SKIP** verdict and a matching exit code (non-zero if any non-skipped check fails).
It covers preflight (tooling, `docker compose config`, registry token, free host ports), build and
`up`, per-service health, `migrate` completion, HTTP reachability through the gateway, and
credential-free discovery proofs run in one-off `docker compose run --no-deps` containers (they
never read `MISTRAL_API_KEY` or touch the network).

### Usage

```bash
# Required for the image build (never baked into a layer — passed as a BuildKit secret):
export MISTRAL_REGISTRY_TOKEN="…"
bash tools/smoke.sh
```

### Configuration

| Var | Default | Purpose |
| --- | --- | --- |
| `MISTRAL_REGISTRY_TOKEN` | — | Pull token for the private index; required to build (BuildKit secret). Not needed with `SKIP_BUILD=1`. |
| `API_PORT` / `WEB_PORT` / `GATEWAY_PORT` / `KEYCLOAK_PORT` | root `.env`, else `3000` / `3001` / `9080` / `8081` | Host ports the stack publishes and the smoke probes, read from Compose itself (`bash tools/compose.sh env`), so `.env` quoting and comments follow Compose's rules. A shell value wins over `.env`. |
| `HEALTH_TIMEOUT` | `300` | Per-service wait (seconds) for healthy/reachable. |
| `HEALTH_INTERVAL` | `5` | Poll interval (seconds). |
| `PROOF_TIMEOUT` | `180` | Per credential-free proof container (seconds). |
| `KEEP_UP` | `0` | `1` = do not tear the stack down on exit. |
| `SKIP_BUILD` | `0` | `1` = reuse existing images (skip `docker compose build`). |
| `USE_PLAYWRIGHT` | `auto` | `auto` / `1` / `0` — assert the shell render if Playwright is available. |
| `COMPOSE_PROJECT` | `scapp-smoke` | Compose project name; override to isolate parallel runs and teardown. |

### Teardown and exit code

On exit the script runs `docker compose down -v` scoped to `COMPOSE_PROJECT`; set `KEEP_UP=1` to
leave the stack running for inspection. Exit code is `0` when every non-skipped check passed and
non-zero otherwise; skipped checks (missing creds, unavailable optional tooling) never count as
passes.
