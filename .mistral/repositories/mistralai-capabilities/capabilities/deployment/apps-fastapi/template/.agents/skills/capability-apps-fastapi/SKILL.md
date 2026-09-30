---
name: capability-apps-fastapi
description: The Mistral Apps × API bridge — the `apps/api/src/api/configure/gateway_token.py` configure hook that mounts the gateway's per-request caller token on the FastAPI host, so a route calling the Mistral API on someone's behalf spends their token, and `python -m cli pre-start`, which runs database migrations before the API starts on Mistral Apps. Use when a route must act as the caller instead of the app's own key, when calls unexpectedly bill the app or raise `MistralNotConfiguredError`, when a setup step must run before the API starts on Mistral Apps, or when deciding whether gateway-credential wiring belongs here vs. `apps` / `fastapi`.
---

# Mistral Apps — API

The Apps × FastAPI seam: render one app-local configure hook into `apps/api` that installs the
gateway's per-request caller token as the credential `utils.mistral` spends, so a route calling the
Mistral API is billed and authorised as whoever made the request rather than against the app's own
key. Hidden — activates when both `apps` and `fastapi` are effective; template-only, delivered via the
Git source. Owns the `gateway_token.py` bridge and the `pre-start` command; defers the token machinery
to `capability-apps` (the `mistralai_capabilities.apps` toolkit + the `utils.mistral` caller-client it
feeds) and the configure-hook discovery to `capability-fastapi` (the host that auto-runs
`configure/*.py`).

`capability.json` declares `python -m cli pre-start` as the API's pre-start command, so Mistral Apps
runs it before every start of the API, and a failing step keeps the API from starting. It runs the
steps in `STEPS` in `pre_start.py` that a selected capability vendored, which today is only
`migrations` from `postgres`.

## Where things live

| Path | What |
| --- | --- |
| `apps/api/src/api/configure/gateway_token.py` | `configure = install_gateway_credentials` — the whole capability. App-local hook `capability-fastapi` auto-discovers and runs at `create_app()`; installs middleware binding this request's `x-apps-token`/`x-space-token` (+ proxy `server_url`) into `utils.mistral`. |
| `apps/api/tests/test_gateway_token.py` | Suite: a probe app asserts the caller token reaches the route (per-request, never shared; `x-apps-token` wins); a `create_app()` check fails loudly if the hook is dropped. |
| `packages/py/cli/src/cli/commands/pre_start.py` | `python -m cli pre-start`: runs each step in `STEPS` whose command module is installed, in order, as `python -m cli <step>`, and stops at the first failure. |
| `packages/py/cli/tests/test_pre_start.py` | Suite: installed steps in `STEPS` run, other init steps never run, and a failing step fails `pre-start`. |
| `ts` pkg `@mistralai-capabilities/deployment-apps-fastapi` | Manifest/template carrier only (`export type … = never`); no runtime code. |

## Extend

- **Call the Mistral API as the caller:** in any route, `caller_mistral_client()` (`utils.mistral`) returns a client bound to this request's gateway token, billed to the caller; a tokenless request → `MistralNotConfiguredError`.
- **Retarget the gateway:** set `apps_proxy_url` / token headers via `capability-apps`' env — don't edit the hook. Any other app wiring belongs in `capability-fastapi`'s `configure/` seam, not here.
- **Run another step before the API starts on Mistral Apps:** add its command module stem to `STEPS` where it belongs in the order. `pre-start` calls it as `python -m cli <stem>` with `_` replaced by `-`, so register the command under that name. It runs on every start of every instance, so make it idempotent, and exit non-zero only when the API can't work without it.

## Gotchas

- No `apps_proxy_url` (a deployment serving the app directly) → installs nothing, no middleware; calls fall back to the app's own key. Installing a provider there would refuse every such call.
- Per request: two callers never share a token, `x-apps-token` beats `x-space-token`, and a tokenless request has no caller to act for (`MistralNotConfiguredError`).
- Only the steps in `STEPS` run on Mistral Apps. The other init steps that Compose and Helm run, such as `custom_rbac`, `guardrail` and `prompts`, do not.
