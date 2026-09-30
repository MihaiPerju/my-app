# Install — `@mistralai-capabilities/feature-agents`

Adds the file-defined orchestrator agent project under `apps/worker/src/worker/agents/`, served as
the `agents` session workflow on the app's worker, plus the prompt-registry init step.

## Prerequisites

- Sibling capabilities: `core`, `fastapi`, `postgres`, `workflows` and `observability`. Tools come
  from capabilities that extend `agents` (e.g. `search`, `connectors`, `guardrailing`,
  `mcp-apps`); live chat needs `chat`.
- `MISTRAL_API_KEY`.
- `ORCHESTRATOR_MODEL` (default `mistral-medium-3-5`): the orchestrator's model; set another one
  when the workspace is rate-limited on the default.
- `PROMPT_REGISTRY_ENABLED` (default `false`): set `true` to source the prompt from the AI Studio
  prompt registry instead of `instructions.md`.
- Keep `AGENT` unset in your shell: the workflows SDK reads it and aborts on a stray value.

## Install

```bash
mistral apps capability add agents
bun run install-all   # sync the new dependencies
```

Verify with `bunx nx run agents:check` (typecheck and tests).

## Environment reference

| Variable                          | Generated default           |
| --------------------------------- | --------------------------- |
| `MISTRAL_API_KEY`                 | (empty)                     |
| `PROMPT_REGISTRY_ENABLED`         | `false`                     |
| `PROMPT_REGISTRY_NAME`            | `{{app_name}}-orchestrator` |
| `PROMPT_REGISTRY_ALIAS`           | `production`                |
| `PROMPT_REGISTRY_TIMEOUT_SECONDS` | `5.0`                       |
