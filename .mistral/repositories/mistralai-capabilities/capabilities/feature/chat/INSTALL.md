# Install — `@mistralai-capabilities/feature-chat`

Adds the `/chat` web page, the `/api/v1/chat` session and feedback routes that forward to the
Mistral agents API, and the `register-agent` step that binds the app's agent to its worker.

## Prerequisites

- Sibling capabilities: `core`, `auth`, `fastapi`, `tanstack-start`, `mistral-design-system`,
  `agents` and `mcp-apps`. `speech` adds dictation and read-aloud as a chat extension; without it
  chat has no mic and no read-aloud.
- Access to the Mistral agents API (`/v2/agents`) for the credential the app uses, or every chat
  call returns 403.
- `MISTRAL_API_KEY`, and `DEPLOYMENT_NAME` (always required by `register-agent`; also the agent's
  name when `VIBE_AGENTS_AGENT_NAME` is blank).
- `VIBE_AGENTS_APPLICATION_NAME` (default `vibe_code_web`) must be an application the agents API
  already knows, or it refuses every call.

## Install

```bash
mistral apps capability add chat
bun run install-all   # sync the new dependencies
bunx nx run fastapi-tanstack-start:gen-types   # regenerate the web API client; commit the diff
```

The compose and Helm init steps register the agent on every deploy. Under a host-only
`mistral apps dev`, register it once the worker is up:

```bash
bunx nx run chat:register-agent
```

Verify with `bun run check`, then run the stack (`bunx nx run compose:dev`) and open a session on
`/chat`.

## Environment reference

| Variable                       | Generated default |
| ------------------------------ | ----------------- |
| `MISTRAL_API_KEY`              | (empty)           |
| `VIBE_AGENTS_AGENT_NAME`       | (empty)           |
| `VIBE_AGENTS_APPLICATION_NAME` | `vibe_code_web`   |
| `VIBE_AGENTS_TIMEOUT_SECONDS`  | `30`              |
