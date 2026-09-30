# deploy/helm/

Operator runbook for the umbrella Helm chart: how deployment init is ordered and extended, and
how to validate the rendered manifests before a release.

## Deployment init (`python -m cli <step>`)

Everything that must run once before the workloads roll runs as an ordered set of Kubernetes
pre-install/pre-upgrade **hook Jobs** — one step, one command module in
`packages/py/cli/src/cli/commands/`, each run as `python -m cli <step>` from the API image (which
does `uv sync --all-packages`, so it already carries every workspace package — the deployment builds
one image, not two).

The order lives in the init subchart, and nowhere else in Python:

- `charts/init/values.yaml` lists the steps under `steps:`, each entry a `name` and a `hookWeight`
  (lower weight runs first). `charts/init/templates/job.yaml` ranges over that list and renders one
  hook Job per entry. An entry may also carry `enabled: false` or its own `resources`, overriding
  the chart defaults for that step alone.

The steps present in a given app depend on the selected capabilities: `migrations` (postgres),
`guardrail` (guardrailing), `prompts` (agents), `agents` (chat), `schedules` (evals). Deselecting a
capability drops its step here and its service in the Compose init chain. The order is deliberate —
schema-creating and corpus-seeding steps run before the steps that fire workflows reading both
schemas.

Nothing in Python orders the steps, and no step knows about another: each is its own unit of
deployment (a hook Job), so ordering, retries, and per-step logs belong to the platform. Every step
is idempotent, so re-running on each release is the intended usage.

### Adding a step

Add a command module `packages/py/cli/src/cli/commands/<step>.py` following Typer's one-file-per-command
layout: it owns an `app = typer.Typer()` with a single `@app.command(name="<step>")` (put async work in
a sync command that calls `asyncio.run(...)`). `cli.main` discovers the module by filename and mounts its
app with `add_typer`, so it runs as `python -m cli <step>`; there is no manifest to hook into. The module
needs no `if __name__ == "__main__":` block and no `configure_logging(...)` call — the CLI configures
logging once in its Typer callback. A crash is a non-zero exit the platform reports. Put a step after
everything it depends on, and make it idempotent — init runs on every deploy.

Then declare where it runs: an entry in this chart's `steps:` list with a `name` and a `hookWeight`
(lower weight runs first). If the Compose capability is also installed, add the matching service to
its init chain (`deploy/compose/`); see `deploy/compose/README.md`. Where a step belongs in the order
is a deployment decision, so each runbook owns its own ordering.

## validate-helm.sh — Helm manifest validation

`tools/validate-helm.sh` lints the umbrella chart, renders it with both the default and production
values, and pipes each manifest set through strict `kubeconform` validation. Schemas for installed
CRDs such as `ExternalSecret` are skipped when unavailable.

Requires `helm` and `kubeconform`:

```bash
bash tools/validate-helm.sh
# or
bunx nx run helm:validate
```
