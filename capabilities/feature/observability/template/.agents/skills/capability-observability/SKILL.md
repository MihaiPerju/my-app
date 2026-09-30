---
name: capability-observability
description: The app's Mistral Studio tracing — automatic SDK and Workflow span export wired by config and the `mistralai[telemetry]` dependency with no setup code, the typed `env.observability` read-back settings, and the vendored `observe` instrumentation skill. Use when Studio traces are missing or duplicated, when setting the OTLP endpoint or the dedicated-vs-global per-process provider, when enabling or gating Studio read-back (`OBSERVABILITY_READ_ENABLED`, the `obs_online_evaluations` flag), or when deciding whether a custom span belongs here or in `observe`.
---

# Observability

Mistral Studio tracing delivered as **config + dependency, not code**: automatic SDK and Workflow span export, the typed `env.observability` read-back settings, and the vendored `observe` skill for custom spans. Owns no route/UI/workflow and depends only on `core`; every SDK client the app creates picks up its process's provider (no shared client, no `configure_telemetry` call), and consumers `agents` and `evals` read `env.observability`.

## Where things live

| Path | What |
| --- | --- |
| `packages/py/env/src/env/observability.py` | `env.observability` read-back settings (`observability_api_base_url`, `observability_read_enabled`, request timeout, `observability_page_size`, `observability_max_pages`); owned here, read by `agents` + `evals`. |
| `.agents/skills/observe/SKILL.md` | Model-invoked `observe` skill: add/review custom spans, verify them in Studio. |
| `tests/test_observability_config.py` | Asserts telemetry runtime imports + export config + `observe` skill vendored. |
| `mistralai_capabilities.observability` | Installed slice via the `mistralai[telemetry]` extra (`package/py` carrier, dist `mistralai-capabilities-feature-observability`). `package/ts` exports `type ObservabilityCapability = never` (type-only). |

Trace export ships no template file; `MISTRAL_*` / `OTEL_ENABLED` land in `.env` from this capability's `envVars`.

## How tracing works

Each process exports through the provider its env names; the SDK inits lazily from the key — nothing here initializes tracing.

- **API / init**: `MISTRAL_SDK_TELEMETRY=dedicated` → dedicated OTLP provider to `MISTRAL_OTLP_TRACES_ENDPOINT`, auth `MISTRAL_API_KEY`. Automatic GenAI spans: chat, embeddings, agent create/invoke, conversations, FIM, OCR.
- **Workflow workers**: `MISTRAL_SDK_TELEMETRY=global` → SDK spans join the Workflows SDK provider (`OTEL_ENABLED=true`); endpoint derived from `SERVER_URL`.
- **In-cluster**: API/init endpoint from `global.observability.mistralOtlpTracesEndpoint` (Helm-injected, not shipped here); workers still use `SERVER_URL`.

Read-back is a separate surface, off by default: `OBSERVABILITY_READ_ENABLED=false` and `/v1/observability/*` sits behind the `obs_online_evaluations` workspace flag (no grant → 404, so consumers log a no-op). `observability_api_base_url` (regular API host, not the OTLP host) serves `/v1/observability/*` (span evaluations, spans, datasets) and `/v2/prompts` (object/prompt registry); consumers are `agents` (Studio client, init `prompts.py`) and `evals` (feedback harvest, honoring page size/max pages).

## Add spans through `observe`

Instrument an app-owned operation or tool call by reading and following the vendored `observe` skill: the `get_telemetry_tracer(client, __name__)` recipe, the `execute_tool <registered name>` span convention, and the secret/duplication rules. Do not re-emit already-automatic SDK/HTTP/Workflow spans, and do not call `mistralai.extra.observability.configure_telemetry` unless deliberately replacing the configured provider.

## Gotchas

- A trace that never arrives is almost always the wrong provider for the process (`dedicated` vs `global`) or a `MISTRAL_API_KEY` outside the target workspace — not missing instrumentation.
- This SDK GenAI tracing is distinct from core's `utils.telemetry.configure_telemetry` (reads `env.telemetry`, wired in `apps/api/main.py`, emits structlog eval-log records over its own OTLP) — a different pipeline; leave it intact.
