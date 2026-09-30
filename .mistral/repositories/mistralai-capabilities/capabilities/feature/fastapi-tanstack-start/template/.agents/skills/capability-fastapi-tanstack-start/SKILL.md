---
name: capability-fastapi-tanstack-start
description: The typed API client `apps/web` generates from the FastAPI OpenAPI contract (hey-api, under `apps/web/src/api/`), its runtime base URL and the `VITE_API_URL` env schema. Use when calling the API from the web app, after changing an API route or schema, or when `gen-types-check` fails in CI.
---

# FastAPI × TanStack Start

Hidden integration: active whenever `fastapi` and `tanstack-start` both are.

## Where things live

| Path | What |
| --- | --- |
| `apps/web/src/api/generated/` | hey-api output (`sdk.gen`, `types.gen`, `client.gen`). Never edit; regenerate. |
| `apps/web/src/api/client-config.ts` | Runtime client config: `baseUrl` from `env.VITE_API_URL` (same-origin by default; paths already include `/api`). |
| `apps/web/src/api/unwrap.ts` | `unwrap(sdkCall)`: typed data, or a real `Error` from FastAPI's `{ detail }`. |
| `apps/web/src/env.ts` | zod-validated `VITE_API_URL`; `SKIP_ENV_VALIDATION` relaxes it. |
| `apps/web/vite-plugins/fastapi-tanstack-start.ts` | Vite plugin: the dev server's `/api` proxy to the API on `:3000`. |
| `apps/web/openapi-ts.config.ts` | Generator config: `../api/openapi.json` → `src/api/generated`. |
| `apps/web/.env.example` | The web app's variables (`VITE_API_URL`, `SKIP_ENV_VALIDATION`); copy to `apps/web/.env`. |
| `packages/ts/fastapi-tanstack-start/project.json` | Nx project `fastapi-tanstack-start`: `gen-types`, `gen-types-check`, and a `check` that depends on `gen-types-check`. |
| `packages/ts/fastapi-tanstack-start/package.json` | Pins the generator, `@hey-api/openapi-ts`; a dependency-only workspace member, hoisted to the root `node_modules`. |

## Workflow

- Change the API, then `bunx nx run fastapi-tanstack-start:gen-types` (dumps `apps/api/openapi.json`,
  regenerates the client) and commit both. `fastapi-tanstack-start:gen-types-check` is CI's drift
  gate, and this project's `check` depends on it, so the root `bun run check` catches drift too: it
  regenerates and fails if the working tree changed, leaving the fresh client in place to commit.
  Both run `tools/gen-types.sh`.
- The scaffold ships the client generated for the registry's full composition. `bun run install-all`
  regenerates it for this app's selection; commit that diff with your first change.
- Call it as `unwrap(chatListSessions({ throwOnError: true }))` inside a TanStack Query `queryFn`.
