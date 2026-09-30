---
name: capability-agents
description: The file-defined orchestrator project (`apps/worker/src/worker/agents/`) plus the worker overlays that promote it and source its prompt — the single `agents.Agent` entrypoint, the contribution packages and their `assemble_harness` toolkit, `instructions.md`, `workflows/agents.py`, and the `PROMPT_REGISTRY_*` pipeline. Use when editing the orchestrator or its prompt, changing how it is promoted to the `agents` session workflow, wiring the prompt registry, adding a capability contribution (tool/connector/hook) to the orchestrator Harness, pinning or packaging the Agents SDK, or debugging agent-project load or the orchestrator census test.
---

# Agents

The file-defined orchestrator the worker runs on the **Unified Harness**, plus the worker overlays
that promote it and pick its prompt. The Unified Harness has **no subagents**: the orchestrator is a
single `agents.Agent` whose `Harness` is assembled *in code* from whatever capabilities are
installed. This capability owns the orchestrator skeleton (`agent.py` + the `assemble_harness` toolkit + the
contribution packages + `instructions.md`), the `workflows/agents.py` promotion, `create_workflow_tools`,
and the prompt-registry pipeline. Sibling capabilities extend the Harness by vendoring one file per
contribution into `{tools,connectors,hooks,mcps}/` — `search` (tools), `connectors` (15 connector slots),
`guardrailing` (the root hook), `mcp-apps` (the `allow_mcp_ui` connector) — while the chat
HTTP surface, control plane, and agent registration live in **chat**.

## Where things live

| Path | What |
| --- | --- |
| `apps/worker/src/worker/agents/agent.py` | The single orchestrator (`name="app-orchestrator"`); entrypoint `worker.agents.agent:agent`. Its Harness comes from `assemble_harness(...)` over the four kind packages. |
| `mistralai_capabilities.agents.assembly` (the capability's `package/py` toolkit) | `assemble_harness(tools=, connectors=, hooks=, mcps=)`: walks each passed kind package and merges each module's singular slot into one `agents.Harness`; a missing slot, wrong type, or duplicate name raises. |
| `.../worker/agents/{tools,connectors,hooks,mcps}/` | Contribution sub-packages by kind. Each installed capability vendors one file per contribution into the sub-package for its kind; agents owns only the `__init__.py` skeletons. |
| `.../worker/agents/instructions.md` | Orchestrator prompt seed + fallback. |
| `.../worker/agents/pyproject.toml` | uv member (`package=false`); exact-pins the SDK; sets `[tool.mistralai.agents].entrypoint`; excludes the contribution packages from `ty`. |
| `.../worker/agents/{conftest.py,project.json}` | Pops stray `AGENT` env; NX `typecheck/test/dev/check` (`typecheck` is `ty check --project <agents dir>`, which reads `[tool.ty]` from the pyproject). |
| `.../worker/workflows/agents.py` | Imports the orchestrator, sources the prompt, promotes it once to the `agents` **session** workflow. |
| `.../worker/workflows/tooling.py` | `create_workflow_tools`: workflow class → `@agents.tool` (`<name>_tool`, idempotent, `model_access="direct"`). |
| `apps/worker/tests/agents/` | Census `test_app.py` (expected surface derived from `.mistral/capabilities.json`); workflow-name/registry `test_feature_agents_workflows.py`. |
| `packages/py/env/src/env/agents.py` | `ORCHESTRATOR_MODEL` (the orchestrator's model) and the `PROMPT_REGISTRY_*` settings. |
| `packages/py/cli/src/cli/commands/prompts.py` | Deploy `init` step publishing `instructions.md` as a registry version. |
| `packages/py/agents/pyproject.toml` | Member carrying the SDK (public PyPI, exact pin) and seeding `pytest`+`ty` into the root env via its `dev` group. |
| `tools/dev_agent.py` | Dev: tunnels the **gateway** (`:9080`), not the API. |

## Extend

- **Contribute a tool/connector/hook:** a sibling vendors ONE FILE PER contribution into `apps/worker/src/worker/agents/<kind>/` exposing that kind's singular slot (`tool` in `tools/`, `connector` in `connectors/`, `hook` in `hooks/`, `mcp` in `mcps/`; a module may set its slot to `None` to opt out). `assemble_harness()` merges them. A capability adds its names under its full identity (`f"{REGISTRY}/<kind>/<id>"`) in `test_app.py`'s `CAPABILITY_*` tables (the registry test `agents-census.test.ts` enforces it); an app adds its own to the `APP_*` sets. The census expects a capability's names only when `.mistral/capabilities.json` lists it as installed. There are no subagents — the Unified Harness does not support them.
- **Change the prompt:** edit `instructions.md`; the registry version is published by the `prompts` command and read at promotion time by `_with_registry_instructions` (any failure falls back to the file). Optimizers ship a candidate then move the `production` alias — no image rebuild.
- **Add a workflow tool:** register via `create_workflow_tools`; connectors (including the MCP `allow_mcp_ui` slot) reach the session workflow through the harness, not a `uses_connectors` wrap.
- The `agents` workflow name is a **frozen wire identifier** — renaming fails replay of in-flight executions. There is no `agents_run` / `type="chat"` workflow: the Unified Harness dropped it, so evals drives the agent via `orchestrator_agent.run()`.

## Gotchas

- The orchestrator's model is `ORCHESTRATOR_MODEL`, not a literal: when a workspace answers 429 on the default, set another model in `.env` rather than editing `agent.py`, which `registry update` would overwrite.
- The census derives its expectations from `.mistral/capabilities.json`, so it holds for any selection; it fails if that file is missing. Tools you add in the app itself go in `APP_TOOLS` (and `APP_CONNECTORS`/`APP_HOOKS`), or the census fails on the extra name.
- `instructions.md` is shared by every composition, so it names no capability's tools: each tool describes itself. Keep capability-specific guidance in the tool's description, not in the prompt.
- `/chat` reaches this orchestrator only when chat fronts this deployment's agent (the default: `VIBE_AGENTS_AGENT_NAME` blank = `DEPLOYMENT_NAME`, registered by `cli agents`). Pointed at the builtin `nuage-session`, none of the tools here are reachable from chat; see `capability-chat`.
- Keep the SDK exact pin identical in the `packages/py/agents` member and the `apps/worker/src/worker/agents` agent-project manifest, and keep the subprocess test asserting no web framework loads on the worker green.
- Hooks contributed to the Harness must be **stateless** — `to_workflow` rejects a stateful hook (`agents.State`) on the deployed session workflow.
