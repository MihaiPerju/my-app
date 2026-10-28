---
name: capability-mcp-apps
description: "MCP Apps delivery for the FastAPI host: the `/mcp` file-router mount, the `apps/api/src/api/mcp_apps` catalog discovery, and the opt-in self-connector, plus the agent-side `allow_mcp_ui` harness connector it contributes to the orchestrator. Use when adding or debugging an `McpApp` declaration, when `/mcp` will not mount or serves the wrong surface, when turning surfacing on or fixing the self-connector (`MCP_APPS_ENABLED`, `MCP_SERVER_URL`), when changing the agent-side `allow_mcp_ui` contribution, or when changing the `mistralai_capabilities.mcp_apps` contract/discovery/server toolkit."
---

# MCP Apps

MCP Apps **delivery** for the FastAPI host: discovers `McpApp` declarations under `apps/api/src/api/mcp_apps/`, serves them at `/mcp` as `ui://` resources plus tools, and — when surfacing is on — registers the app's own MCP server as a self-connector. App declarations belong to whichever feature capability ships them. This capability also owns the **agent-side** half of MCP-app surfacing: the `allow_mcp_ui` harness connector, contributed into the orchestrator's per-kind contribution seam (`worker/agents/connectors/mcp_apps.py`). The model opens an app by calling its tool through that connector; the Unified Harness annotates the call (`mcp_app`) and the session UI renders the tool's `_meta.ui.resourceUri`. There is no separate open-app tool. That worker overlay is why `mcp-apps` **depends on `agents`** (for the Agents SDK) — the API host still never imports the SDK, since the overlay lives under `apps/worker`, not `apps/api`. Depends on **core** (settings, Mistral client), **fastapi** (host + file router), and **agents** (the orchestrator per-kind contribution seam).

## Where things live

Runtime toolkit `mistralai_capabilities.mcp_apps` is installed (not vendored); its `__init__` is empty and submodules split by import weight, so importing one never loads a sibling:
- `.contract` — `McpApp` model (stdlib + pydantic; every catalog module imports it, keep cheap).
- `.discovery` — `discover_mcp_apps()` (stdlib only).
- `.server` — `create_mcp_app()`, `ensure_app_connector()` (FastMCP, imported lazily inside `create_mcp_app`).

| Path | What |
| --- | --- |
| `packages/py/env/src/env/mcp.py` | `env.mcp` settings: `mcp_apps_enabled` gate, connector identity/visibility, `mcp_server_url` (falls back to `__APPS_PUBLIC_ORIGIN` or `__SPACES_PUBLIC_ORIGIN` plus `/mcp`), `mcp_app_ui_url` (feeds CSP `frameDomains`). |
| `apps/api/src/api/routers/mcp/route.py` | Builds the MCP server from the catalog, mounts at `/mcp` (`router.mount("", mcp_app)`), runs the self-connector as a lifespan task. |
| `apps/api/src/api/routers/mcp/__init__.py` | `dependencies = ()` — `/mcp` served without `require_user`. |
| `apps/api/src/api/mcp_apps/__init__.py` | The catalog; ships empty, one module per app, `py.typed` beside it. |
| `apps/api/tests/test_mcp_app_discovery.py` | Runs discovery in the suite (bare-basename name avoids the worker's `test_discovery.py`). |
| `apps/api/tests/test_mcp_router.py` | Asserts `/mcp` mounts, exposes zero route-derived tools, transport reachable. |
| `apps/worker/src/worker/agents/connectors/mcp_apps.py` | The `allow_mcp_ui` harness connector (`connector`, `None` when gated off), gated on `mcp_apps_enabled`; how the deployed session workflow surfaces MCP UI (the harness carries `allow_mcp_ui` into the workflow — no `uses_connectors` wrap). |
| `apps/worker/tests/agents/test_mcp_apps_connector.py` | Pins the slot: `allow_mcp_ui` on the self-connector when enabled, `None` when off. |

## Add an MCP App

Drop a module into `apps/api/src/api/mcp_apps/`; `discover_mcp_apps("api.mcp_apps")` scans it one level deep, sorted, at boot.
1. Bind an `McpApp` to the module-level name **`app`** (naming contract, not a type scan — any other name is ignored). Flat app = `<name>.py`; app with a view template = a directory declaring in its `__init__.py`. A module declaring no `app` is fine.
2. Author with `from mistralai_capabilities.mcp_apps.contract import McpApp`.
3. A view is a **zero-arg** resource fn (a param makes FastMCP treat it as a template); `create_mcp_app` wraps each `build_view(base)` in a factory. Its `_meta.ui.csp.frameDomains` must include the UI origin (`mcp_app_ui_url`, default = CORS origin); extend via `McpApp.extra_frame_domains`.

## Self-connector (opt-in)

`ensure_app_connector` upserts the app's MCP server as an `allow_mcp_ui` connector; the `/mcp` lifespan spawns it unconditionally but it is gated twice (`mcp_apps_enabled` **and** non-null `mcp_server_url`) → no-op when off. Turn on with `bunx nx run agents:dev` behind a tunnel; deployed, the platform's public origin supplies the URL. Takes a client **factory** (no client built while off); self-heals (repoints drifted `server`, recreates drifted `visibility`); fail-soft (retries 10×3s, connector-API errors log and return). Name `mcp_connector_name` — the `allow_mcp_ui` harness connector this capability contributes (`connectors/mcp_apps.py`) keys off the same value.

## Gotchas

- Discovery **raises** `McpAppDiscoveryError` (unimportable module, or a tool name / `ui://` URI claimed twice) — fails boot, never log-and-skip.
- The MCP server mirrors **no** HTTP routes: the agent drives workflows directly, so there is no second invocation path.
- Nothing surfaces until the catalog declares an app **and** `MCP_APPS_ENABLED` is on; the catalog ships empty.
- The agent-side worker overlay lives under `apps/worker/src/worker/agents/`, so it needs the `agents` capability present; that is why `mcp-apps` depends on `agents`, not the reverse.
