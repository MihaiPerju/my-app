# Install — `@mistralai-capabilities/backend-fastapi`

Adds the app's HTTP backend: a FastAPI host at `apps/api` with a file-based router and health
routes, served on port 3000, plus `deploy/docker/Dockerfile.api`. Feature capabilities add their
routes by dropping files into it.

## Prerequisites

- **Sibling capabilities** — `core`.
- **`CORS_ORIGIN`** — the browser origin allowed to call the API (defaults to the web app,
  `http://localhost:3001`).

## Install

```bash
mistral apps capability add fastapi
bun run install-all   # sync the new dependencies
```

Verify: `bunx nx run api:serve` starts the API with hot reload (`HOST`/`PORT` default to `0.0.0.0`
and `3000`), and `curl http://localhost:3000/api/health/live` returns 200.

## Environment reference

| Variable      | Default                 |
| ------------- | ----------------------- |
| `CORS_ORIGIN` | `http://localhost:3001` |
