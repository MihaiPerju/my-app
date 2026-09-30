# Install — `@mistralai-capabilities/frontend-tanstack-start`

Adds the app's frontend: a TanStack Start app at `apps/web` (file-based routes, TanStack Query,
Tailwind) served on port 3001, plus `deploy/docker/Dockerfile.web`.

## Prerequisites

- **Sibling capabilities** — `core`.
- **Environment variables** — none required. `APP_NAME` (optional) names the app in the title and
  sidebar. With `fastapi` installed, `fastapi-tanstack-start` ships `apps/web/.env.example`; copy it
  to `apps/web/.env` so the dev server can reach the API (`VITE_API_URL`).

## Install

```bash
mistral apps capability add tanstack-start
bun run install-all   # sync the new dependencies
```

Verify: `bun run dev:web` serves the app on http://localhost:3001, and `bunx nx run web:build`
succeeds.
