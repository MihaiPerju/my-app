# Install — `@mistralai-capabilities/feature-mcp-apps`

Serves the app's MCP Apps at `/mcp` on the FastAPI host, registers the app's own MCP connector, and
exposes it to the agent so the session UI can render the apps.

## Prerequisites

- **Sibling capabilities** — `core`, `fastapi` and `agents`.
- **`MCP_APPS_ENABLED`** — `false` by default; set it to `true` to register the connector and surface
  apps to the agent.
- **`MCP_SERVER_URL`** — when enabled, a publicly reachable URL of the app's `/mcp` endpoint; the
  platform cannot reach the default `localhost` URL. Point it at the gateway (port 9080), never the
  API port: the API trusts identity headers unverified. `bunx nx run agents:dev` sets this up.
  A deployed app falls back to the platform's public origin plus `/mcp`, which the capability
  declares as an MCP route.

## Install

```bash
mistral apps capability add mcp-apps
bun run install-all   # sync the new dependencies
```

Add an app by dropping a module that binds an `McpApp` to a module-level `app` into
`apps/api/src/api/mcp_apps/`. Verify: with the API running
(`bunx nx run api:serve`), the MCP server answers at http://localhost:3000/mcp.

## Environment reference

| Variable                   | Default                     |
| -------------------------- | --------------------------- |
| `MCP_APPS_ENABLED`         | `false`                     |
| `MCP_SERVER_URL`           | `http://localhost:3000/mcp` |
| `MCP_APP_UI_URL`           | empty (uses `CORS_ORIGIN`)  |
| `MCP_CONNECTOR_NAME`       | `{{app_name}}`              |
| `MCP_CONNECTOR_VISIBILITY` | `shared_workspace`          |
