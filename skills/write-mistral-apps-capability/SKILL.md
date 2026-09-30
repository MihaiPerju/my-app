---
name: write-mistral-apps-capability
description: Author a capability in the `mistralai-capabilities` registry — topology, `capability.json`, package and template zones, verification. Use when creating or restructuring a capability for the `mistral apps` CLI.
---

# Authoring a capability

Read the registry's `AGENTS.md`, then one existing capability of the same kind —
`capabilities/feature/chat/` for a full feature. Copy current shapes rather than recalling them.
Read [`REGISTRY.md`](../contribute-capabilities/REGISTRY.md) before writing `template/` or setting
`metadata.public`: it holds the template rules and the gates.

## 1. Scaffold

```bash
mistral apps capability init <id>   # at the registry root
```

Move the result to `capabilities/<kind>/<id>/`, where both segments equal the manifest's `kind` and
`id`; kinds are listed in `registry.config.json`. The manifest contract lives in
`scripts/shared/manifests.ts` and `scripts/registry/build-registry.ts`.

## 2. `capability.json`

| Field | Rule |
| --- | --- |
| `version` | Keep the placeholder; release tags stamp it. |
| `required` | Only `core`. |
| `visible` | `false` hides it from discovery; it stays selectable. |
| `dependencies` | `id`, `kind/id` or `registry/kind/id`; they define the install closure. |
| `activatedWhen.allOf` | Makes it derived: active when all listed are. Keep those out of `dependencies`. |
| `packages` | Shipped languages (`ts`, `py`); omit for template-only. |
| `module` | The app module it serves, if any (below). |
| `envVars` | Defaults; `{{app_name}}` and `{{env:NAME}}` expand. |
| `metadata.weight` | Display order only. |
| `metadata.public` | Explicit boolean, `false` unless it publishes publicly (see `REGISTRY.md`). |

```json
{ "serve": "static", "route": "/", "browser": true }
{ "serve": "server", "route": "/api", "browser": false }
{ "serve": "worker" }
```

App modules also carry `metadata.appDir`, `metadata.port` and `metadata.lifecycle`: copy them from
`frontend/tanstack-start`, `backend/fastapi` or `backend/workflows`.

A capability with no module can still declare top-level `routes`, which the CLI adds to an existing
module in apps.json. Set `metadata.appDir` to that module's directory when the template writes into
more than one app, as `feature/mcp-apps` does with `apps/api`.

A capability that needs a database declares top-level `"database": { "engine": "postgres" }`, as
`database/postgres` does. The CLI adds it to apps.json as a managed module named after the
capability, and an app gets at most one.

## 3. Zones

**`package/`** — reusable runtime code, named by convention: npm `@mistralai-capabilities/<kind>-<id>`,
Python distribution `mistralai-capabilities-<kind>-<id>`, module `mistralai_capabilities.<id>` under
`package/py/src/mistralai_capabilities/<id>/`, declared by `[tool.uv.build-backend]`
`module-name = "mistralai_capabilities.<id>"` and `namespace = true`. Relationships between
capabilities go in `capability.json`; template `package.json` files list no
`@mistralai-capabilities/*` dependency, since the CLI writes those edges.

**`template/`** — files at their final app path, discovered by the app's file trees:

- API routes: `template/apps/api/src/api/routers/api/v1/<id>/`
- Web: `template/apps/web/src/features/<id>/` and a route under `template/apps/web/src/routes/`
- Worker: `template/apps/worker/`; shared Python: `template/packages/py/`
- The app-facing guide: `template/.agents/skills/capability-<id>/SKILL.md`

Use `.hbs` only for install-time glue.

## 4. Document and verify

Write `INSTALL.md` when users have prerequisites, and an `[Unreleased]` entry in `CHANGELOG.md`. Put
runtime tests beside the code, registry invariants in `tests/registry/`. Then pass the gate in
[`REGISTRY.md`](../contribute-capabilities/REGISTRY.md#the-gate).

Done when the descriptor and pins are regenerated and committed, the gate passes, and the changelog
states any action a consuming app must take.
