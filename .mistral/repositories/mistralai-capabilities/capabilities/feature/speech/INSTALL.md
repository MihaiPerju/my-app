# Install — `@mistralai-capabilities/feature-speech`

Adds Voxtral transcription and speech synthesis: workflow activities, the `v1/speech` API routes
and chat's dictation and read-aloud, as a chat extension. It ships no page of its own.

## Prerequisites

- Sibling capabilities: `core`, `fastapi`, `tanstack-start`, `workflows`, `auth` and `chat`.
- A running worker (`workflows`), connected to the platform at `WORKFLOWS_BASE_URL`, to execute the
  transcribe and synthesize workflows.
- `MISTRAL_API_KEY`: required, used to call the Mistral speech APIs.

## Install

```bash
mistral apps capability add speech
bun run install-all   # sync the new dependencies
bunx nx run fastapi-tanstack-start:gen-types   # regenerates apps/api/openapi.json and the web client; commit both
```

Verify:

```bash
bunx nx run quality:check-ts
bunx nx run quality:typecheck
bunx nx run testing:test
```
