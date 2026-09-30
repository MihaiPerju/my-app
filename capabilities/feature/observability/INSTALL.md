# Install — `@mistralai-capabilities/feature-observability`

Sends Mistral SDK and Workflow traces to Mistral Studio, adds an opt-in client for reading Studio
spans and evaluations back, and installs an `observe` agent skill for instrumenting app code.

## Prerequisites

- Sibling capability: `core` (resolved automatically).
- `MISTRAL_API_KEY` belonging to the Studio workspace that should receive the traces.
- For a dedicated Studio deployment: set `MISTRAL_OTLP_TRACES_ENDPOINT` to its
  `https://<studio-host>/telemetry/v1/traces` endpoint (Helm:
  `global.observability.mistralOtlpTracesEndpoint`), and point the worker's `WORKFLOWS_BASE_URL`
  at the deployment base URL, since Workflow workers derive their trace endpoint from it.
- Reading traces in Studio, and `OBSERVABILITY_READ_ENABLED=true`, both require the workspace to
  have access to Studio observability; without it every read-API call returns 404.

## Install

```bash
mistral apps capability add observability
bun run install-all   # sync the new dependencies
```

Existing Mistral SDK clients are traced with no code changes. To instrument app-owned operations or
tool calls, ask the agent to `/observe` the relevant path. Verify by exercising the app and checking
the [Mistral Studio Trace Explorer](https://console.mistral.ai/observability/traces).

## Environment reference

| Variable                                | Generated default                            |
| --------------------------------------- | -------------------------------------------- |
| `MISTRAL_API_KEY`                       | (empty)                                      |
| `MISTRAL_OTLP_TRACES_ENDPOINT`          | `https://api.mistral.ai/telemetry/v1/traces` |
| `MISTRAL_SDK_TELEMETRY`                 | `dedicated`                                  |
| `OTEL_ENABLED`                          | `true`                                       |
| `OBSERVABILITY_READ_ENABLED`            | `false`                                      |
| `OBSERVABILITY_API_BASE_URL`            | `https://api.mistral.ai`                     |
| `OBSERVABILITY_REQUEST_TIMEOUT_SECONDS` | `30.0`                                       |
| `OBSERVABILITY_PAGE_SIZE`               | `100`                                        |
| `OBSERVABILITY_MAX_PAGES`               | `50`                                         |
