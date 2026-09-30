---
name: capability-fastapi-workflows
description: The hidden bridge between the `fastapi` and `workflows` capabilities — the `api/health/metadata/deployment.py` provider that reports `env.workflows.deployment_name` as the health route's `deployment` field. Use when the health response's `deployment` is missing or stale, when adding or renaming a `health/metadata/` provider, or when tracing why this file exists though neither parent capability ships it.
---

# FastAPI — Workflows

The one seam that joins the two capabilities it depends on: it drops a single **health-metadata
provider** into the API host that reports the **workflows deployment name**. That bridge is all it
owns. The discovery machinery and the health route belong to `fastapi`; the
`env.workflows.deployment_name` setting and the worker belong to `workflows`. This capability is
hidden (`visible: false`) and auto-activates only when **both** are selected
(`activatedWhen.allOf: ["fastapi", "workflows"]`); it is never chosen on its own, because it imports
`env.workflows` and lands in `fastapi`'s discovery namespace, so it only works when both are present.

## What it ships

| Path | Role |
| --- | --- |
| `apps/api/src/api/health/metadata/deployment.py` | The metadata provider: `metadata() -> str \| None` returns `env.workflows.deployment_name`. `fastapi`'s `FastAPIHooks.discover` finds it by scanning the `api.health.metadata` package for a `metadata` symbol. |
| `apps/api/tests/test_workflows_metadata_hook.py` | Pins the hook to the env — asserts `metadata() == workflows_env.deployment_name`, so a hardcoded or drifted value fails. |

The capability also declares a `ts` package (`packages: ["ts"]`), but it is an empty carrier:
`package/ts/index.ts` is only `export type FastApiWorkflowsCapability = never`, no runtime. The
capability's whole behavior is the Python provider above.

## The module name is the metadata key

`fastapi`'s health route reads exactly one key — `manager.metadata_values.get("deployment")` fills
`HealthResponse.deployment`. That key is the provider **module's basename**: `deployment.py` →
`"deployment"`. Renaming the file silently empties the field, because `.get` returns `None` rather
than raising. Keep the filename `deployment.py`.

## The value is captured once, at boot

`FastAPIHooks.discover` **calls** each provider during discovery
(`metadata_values = {name: provider() for name, provider in ...}`) and stores the returned string,
not the callable. So `deployment` reflects `DEPLOYMENT_NAME` as it stood when the process started;
changing the env afterward needs an API restart to show up in the health response.

## Does a new provider belong here?

Only if it bridges **workflows → health metadata** — this capability owns that single edge. An
unrelated health-metadata provider belongs in `fastapi` (or its own integration); a new workflows
setting belongs in `env/workflows.py` under `workflows`.
