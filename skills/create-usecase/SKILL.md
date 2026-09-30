---
name: create-usecase
description: Create a use case app on the `mistralai-capabilities` registry — scope it with `/scope-usecase`, scaffold and trim it to the spec, run it, add workflow-backed features, brand it. Use when starting a Mistral Solutions app, adding a feature to one, or when a generated app fails to install, migrate or check.
---

# Creating a use case

An app is scaffolded from the `mistralai-capabilities` registry, then trimmed to the use case.
Run `/setup-mistral-apps` first on a new machine: it installs the dev tools, the CLI and the
Cloudsmith credentials everything below needs. Read `mistral-apps-cli` whenever a `mistral apps`
command fails; this skill owns what is true of this registry's apps.

## 1. Scope

Run a `/scope-usecase` session, feeding it whatever the user brings — notes, a transcript, a
draft — and come back with the spec it ends on. Skip this step only when changing an app that
already exists.

Read the spec into a capability set:

- Scope and environment: documents → `search`, a conversational surface → `chat`, voice → `speech`,
  SaaS reach → `connectors`, prompt and response safety → `guardrailing`, deployment constraints → a
  `deployment/*` capability.
- Success thresholds → `evals`, which is what makes success testable.

Done when data and environment carry no open question and you hold the capability list. Those two
stall a build after it starts: take their open questions to the customer first.

## 2. Scaffold

```bash
git ls-remote --tags --sort=-v:refname https://github.com/mistralai/mistralai-capabilities | head -3
mistral apps init <app> --source git \
  --registry-url='https://github.com/mistralai/mistralai-capabilities.git#<tag>' \
  --caps docker-compose,code-quality,testing,<capabilities from the spec>
```

`--caps` is the whole set: name `code-quality` and `testing` yourself, and `docker-compose` for a
local stack, which is not a default at current tags. Check `default` in `registry.json` at yours;
the repository is private, so an anonymous `raw.githubusercontent.com` URL answers 404:
`gh api 'repos/mistralai/mistralai-capabilities/contents/registry.json?ref=<tag>' -H 'Accept: application/vnd.github.raw'`.
`mistral apps capability list --registry-url '<url>#<tag>'` lists them before the app exists. Read
each chosen capability's `INSTALL.md` (under
`.mistral/repositories/mistralai-capabilities/capabilities/<kind>/<id>/` once scaffolded) and satisfy
its prerequisites.

This skill tracks the registry's `main`. When your tag is older, the vendored
`.agents/skills/capability-<id>/SKILL.md` files describe the code you actually have.

Done when `mistral apps capability list` shows every capability installed and the scaffold is
committed.

## 3. Run

```bash
bun run install-all                   # needs MISTRAL_REGISTRY_TOKEN (see below)
# set MISTRAL_API_KEY in the root .env — init leaves it empty
bunx nx run fastapi-tanstack-start:gen-types             # commit anything it changed
bunx nx run compose:dev               # foreground; `compose:dev -- -d` detaches
```

`init` wrote the root `.env` with every capability's settings; keep it rather than copying the root
`.env.example` over it, which only declares the app's own settings (see *Add a feature*).
`apps/web/.env` is only for running web on the host; under Compose the web container gets
`VITE_API_URL` from Compose.

Call `uv` as `bash tools/uv.sh <args>`: it turns `MISTRAL_REGISTRY_TOKEN` into the npm and uv
credentials and drops `AGENT`. A vendored capability skill showing a bare `uv run …` means the same
command through the wrapper. Sync with `bun run install-all` or `bash tools/uv.sh sync --all-packages`:
the root project is not a package, so a plain `sync` uninstalls every workspace member and imports
like `worker` stop resolving.

If `fastapi-tanstack-start:gen-types` changes the committed client on a fresh app, commit
`apps/api/openapi.json` and `apps/web/src/api/generated/` before building features, or the first
`bun run check` fails.

**Cloudsmith credentials are in `~/.env.cloudsmith`.** When `MISTRAL_REGISTRY_TOKEN` is unset in
your shell (it started before setup wrote the rc), load it without printing it:
`set -a; . ~/.env.cloudsmith; set +a; export MISTRAL_REGISTRY_TOKEN="$CLOUDSMITH_PASSWORD"`.

**The schema ships with the capabilities.** Every capability that owns a table ships its baseline
revision as the root of its own labelled Alembic branch (`fastapi_auth_0001`, `search_0001`, …).
Compose's `init-migrations` (the Helm init job in a cluster) applies them with `upgrade heads`;
`bunx nx run db:migrate` does the same from the host. A fresh app needs no `db:revision`.

The first `compose:dev` builds the api, worker, init and web images: budget about 6 GiB of Docker
disk per app.

Done when http://localhost:9080 serves the app after signing in as `dev` / `dev`. Keycloak's admin
console is on `:8081` (`admin` / `admin`). For a tighter loop: `bunx nx run api:serve`,
`bunx nx run worker:serve`, `bun run dev:web`. Behind `auth` those host processes are only
reachable with an identity through the gateway, which routes to the Compose services.

**Test it in a browser yourself** with `playwright-cli` (installed by `/setup-mistral-apps`; its
`playwright-cli` skill lists the commands) rather than asking the user to click through:
`playwright-cli open http://localhost:9080`, sign in as `dev` / `dev`, then drive the flow, read the
snapshots and `playwright-cli screenshot` what you claim works. Pass `-s=<app>` to keep one session,
and its sign-in, per app.

## 4. Add a feature

A feature is **one workflow class**: its entrypoint type hints are the request and response schema,
and the API routes, OpenAPI and web client are generated from it. Each seam is discovered from its
directory, so there is nothing central to register unless the table says otherwise:

| Seam | File |
| --- | --- |
| workflow | `apps/worker/src/worker/workflows/<feature>.py` |
| activities and schemas | `apps/worker/src/worker/<feature>/{activities,schemas}.py`. When the API needs them too, move them to a uv member `packages/py/<feature>/`, listed in `apps/worker/pyproject.toml` `dependencies` and `[tool.uv.sources] <feature> = { workspace = true }`. Do the same for `db`, which the worker lacks by default. |
| agent tool | `apps/worker/src/worker/agents/tools/<tool>.py` exporting `tool`: `@agents.tool(name=…, input_schema=…, model_access="direct")` over `@workflows.activity(name=…)`. The prompt is `apps/worker/src/worker/agents/instructions.md`; `connectors/`, `hooks/` and `mcps/` beside `tools/` are discovered the same way. |
| workflow HTTP mount | `apps/api/src/api/routers/api/v1/<feature>/`: `__init__.py` (required) and `route.py` exporting `router = WorkflowRouter(<Workflow>, name=…, wait_for_result=True)`. The path is the URL (`route.py` is the directory index, `<name>.py` adds `/<name>`); `v1` requires sign-in. |
| plain endpoint (reads, CRUD) | `apps/api/src/api/routers/api/v1/<feature>/<name>.py` exporting `router = APIRouter(tags=[…])`, handlers bound to `""` returning Pydantic models: `test_every_json_route_declares_a_typed_response` rejects untyped JSON. `speech/voices.py` is the reference. |
| app table | `packages/py/db/src/db/models/<table>.py` plus the app's own revision; see *App tables*. |
| web page | `apps/web/src/routes/_app/<feature>.tsx` (pages under `_app/` get the sidebar shell), with `staticData: { nav: { label, icon, group } }` on `createFileRoute("/_app/<feature>")` for its sidebar row; the `capability-mistral-design-system` skill has the example. Feature code lives in `apps/web/src/features/<feature>/` and calls the API through the generated client in `apps/web/src/api/generated/`. |
| panel beside the chat (with `chat`) | A chat side app: a child route of the chat layout, `routes/_app/chat/<app>.tsx`, declaring `staticData.chatApp` (`label`, `icon`, optional `tools` whose live tool calls open it, optional `fullscreen` page). It opens at `/chat/<app>` beside the conversation and is listed in the composer's Apps menu; nothing in chat is edited. It reads `messages`, `toolEvents`, `sessionId`, `isResponding` and `openedBy` with `useChatContext()` from `@/features/chat/chat-context`. The `capability-chat` skill's "Add a side app" section has a complete example. Tool names in `tools` are bare; a namespaced call (`client.<tool>`) matches on the suffix. |
| chat composer / answer capability (with `chat`) | A chat extension: `apps/web/src/features/chat/extensions/<feature>.ts` default-exporting a `ChatExtension` (`transcribeAudio?`, `synthesizeSpeech?`); chat merges it and shows the control it powers. `speech`'s extension is the worked example. |
| app settings | `packages/py/env/src/env/<feature>.py`: an `Env(BaseEnv)` and a module-level `env = Env()`. Give each field its default there and declare its bare name (`MY_SETTING=`) in the committed root `.env.example`; `tests/test_composed_env_contract.py` fails on a setting declared nowhere and on a value in `.env.example`. |

Three rules hold the seams together:

- **Workflows are deterministic** so the hosted platform can replay them: every SDK and network call
  lives in an activity.
- **The gateway owns identity.** APISIX on `:9080` authenticates against Keycloak and injects
  `x-user-id` / `x-user-email`; the API trusts those headers and stays loopback-bound.
- **`AGENT` is a reserved env name**: setting it breaks every workflows SDK import.

To reach a workflow from `/chat`, add a tool file wrapping it with `create_workflow_tools` and add its
name to `APP_TOOLS` in `apps/worker/tests/agents/test_app.py`. Read `create_workflow_tools`'s
docstring (`apps/worker/src/worker/workflows/tooling.py`) first: when it runs the workflow inline in
the tool's activity, workflow-context calls (`workflow.uuid4()`, `workflow.now()`, timers) fail, and
`mistralai_capabilities.workflows.client.dispatch_workflow` runs it on the worker instead. Chat's
`toolEvents` and history may name a tool with its namespace (`client.<tool>`): match on the suffix. Chat talks to the agent named
`DEPLOYMENT_NAME`, bound by the compose and Helm init step; under a host-only `mistral apps dev`, run
`bunx nx run chat:register-agent` once the worker is up. An unregistered name fails the first chat
turn; a name bound to another deployment fails the init step rather than rebinding.

Generated files — `routeTree.gen.ts`, `openapi.json`, `**/generated/`, lockfiles — are rewritten
by their generators: change the source. Run `bunx nx run fastapi-tanstack-start:gen-types` and
commit both `apps/api/openapi.json` and `apps/web/src/api/generated/`.
`fastapi-tanstack-start:gen-types-check` regenerates and runs `git diff --exit-code`, which compares
against the index, so `git add` what `gen-types` wrote before it can pass.

### App tables

1. The model: `packages/py/db/src/db/models/<table>.py`, one `SQLModel, table=True` class; `db.models`
   imports every module there. Queries go in `packages/py/db/src/db/accessors/<table>.py`.
2. The revision, by hand after a shipped baseline such as `fastapi_auth_0001_users.py`:
   `packages/py/db/src/db/migrations/versions/<app>_0001_<slug>.py` with `<app>` in snake_case,
   `revision = "<app>_0001"` (32 characters at most), `down_revision = None`,
   `branch_labels = ("<app>",)`, one `op.create_table` per table. Later ones chain on
   `down_revision = "<app>_0001"`.
3. `bunx nx run db:migrate`.

`packages/py/db/tests/test_migration_set.py` checks that every root carries a branch label and every
model table is created by some revision. It renders each `upgrade()` offline (`as_sql=True`), so
`op.bulk_insert` dates must be `datetime.date`, never strings, and JSON values cannot render at all.
Seed data belongs in the app's revision; skip the inserts offline:

```python
def upgrade() -> None:
    items = op.create_table("items", ...)
    if op.get_context().as_sql:  # offline rendering: JSON values have no SQL literal
        return
    op.bulk_insert(items, ROWS)
```

A seeded role you `SET ROLE` to later needs `GRANT <role> TO CURRENT_USER` in the same revision when
the migrating user is not a superuser. The compose Postgres init SQL runs only on a fresh volume: no
place for app data.

### Pass the gate

`bun run check` builds every project, then runs every `check` target: `quality` (ruff, ty,
oxfmt/oxlint, audit, shellcheck, hadolint), `testing` (both coverage ratchets) and
`fastapi-tanstack-start` (its `check` depends on `gen-types-check`). `quality:lint-docker` runs
hadolint in a container, so confirm `docker info` answers first. Run one step with `bunx nx run quality:<step>`; `quality:check-ts` alone needs
`apps/web/src/routeTree.gen.ts`, which only `bunx nx run web:build` writes.

- **Coverage ratchets** (set in `tools/testing.sh`): a feature without tests drags the total under
  them. Python tests go in the owning project's `tests/`; web tests are `*.test.ts(x)` beside the code.
- **Anti-slop rules** (TypeScript): parse data where it enters with a zod schema and pass the inferred
  type on; only a type predicate takes `unknown`; precede every remaining `as` with a `// SAFETY:`
  comment. Run `bash tools/quality.sh fix`, then `check-ts`. The `capability-code-quality` skill
  lists the rules.

Done when `bun run check` passes with your feature's tests and the regenerated files committed, and you have run the feature
end to end through `playwright-cli` — from its page, or from `/chat` for a tool — against the running
stack.

## 5. Brand it

`init` already stamps the app name into `.env` (`APP_NAME`, which the web app's title and sidebar
brand read at build time), the Keycloak realm and the Compose project. The rest is yours:

- `apps/web/src/shell/app-shell.tsx` (logo, labels; with `mistral-design-system`), `apps/web/src/index.css` and
  `apps/web/src/styles/` (theme), `apps/web/public/favicon.svg`.
- The orchestrator name `app-orchestrator` in `apps/worker/src/worker/agents/{agent.py,pyproject.toml}`.
- Root `package.json` `name`, `README.md`, `AGENTS.md`.

Done when each file above carries the customer's identity, and
`grep -rn mistralai-capabilities --exclude-dir=.mistral --exclude-dir=node_modules .` finds only
import paths and package names.

## 6. Upstream

Review what you changed while building, and hand every change the next app would want to
`/contribute-capabilities`, which opens the PR to the registry:

- **A bug or workaround in a capability** — anything under `.mistral/`, a patched template copy,
  a hand fix like the ones in *Pitfalls*.
- **A missing guard, setting or doc** that cost you time.
- **A feature that is generic** beyond this customer: extract it into a new capability.

The customer-specific rest stays in the app.

Done when each such change has an open PR, or the user has declined it.

## Pitfalls

- **`bun install` rejects `@mistralai/ui` "published within minimum release age".** A global
  `~/.bunfig.toml` `minimumReleaseAge` catches first-party packages. Add
  `minimumReleaseAgeExcludes = ["@mistralai/ui"]` under `[install]` in the app's `bunfig.toml`, then
  `bun run install-all`.
- **A bare 401 that names no host**, from `init` or `bun install`: the Cloudsmith token is
  missing from `~/.npmrc` or `MISTRAL_REGISTRY_TOKEN`. Load `~/.env.cloudsmith` as in *Run*; when
  the file is missing, run the Cloudsmith step of `/setup-mistral-apps`. When the token is set and still refused, the user lacks the
  `sdk-distribution` entitlement, granted in `iac-solutions` under `cloudsmith/config/`.
- **`init` warns `uv lock failed (continuing)`** and exits 0 — a 401 even with the index
  credentials exported, or a misleading
  `only fastapi[…]<0.122 is available` when an ambient `UV_EXTRA_INDEX_URL` with
  `UV_INDEX_STRATEGY=first-index` shadows PyPI. Its bare `uv lock` lacks `tools/uv.sh`'s credentials,
  so the scaffold has no `uv.lock`. `bun run install-all` writes it; commit it.
- **A new dependency fails to resolve** although it exists: resolution enforces a freshness cutoff
  and an explicit private index, so it can fail on policy rather than availability.
- **`init-migrations` fails with `Can't locate revision identified by '…'`.** The Compose project,
  and its `pg_data` volume, is named after the app, so an earlier app of the same name left its
  revisions there. Drop it with `bunx nx run compose:dev-down -- -v`, or set a new
  `COMPOSE_PROJECT_NAME`.
- **A second app or checkout on the same host** needs, in its root `.env`: a unique
  `COMPOSE_PROJECT_NAME` (a second checkout of the same app otherwise takes over the first's
  containers and volumes); a unique `DEPLOYMENT_NAME` (the worker's task queue and the chat agent's
  name, otherwise the workers take each other's tool calls); and its own published ports, listed in
  `deploy/compose/README.md` with the URLs that move with them (`DATABASE_URL` for `POSTGRES_PORT`).
  Budget ~6 GiB of images per app and run stacks detached (`compose:dev -- -d`).
