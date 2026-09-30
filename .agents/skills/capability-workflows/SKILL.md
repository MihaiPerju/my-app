---
name: capability-workflows
description: >-
  Use when writing, editing, or debugging Mistral Workflows code (`mistralai.workflows`): workflows and activities, background jobs, multi-step pipelines, scheduled tasks, durable LLM agents, conversational workflows with human-in-the-loop, event streaming, third-party connectors, and any process needing fault tolerance, retries, or long-running execution. Also use when a determinism-sandbox error fires, when configuring payload encryption or a managed deployment, when driving executions from application code, and before reporting a workflow as done — it has to be linted and test-run first. Covers the determinism and import rules, the Mistral AI plugin API, activity timeouts and retries, worker discovery and registration, signals and HITL, and the vendored SDK reference documentation.
license: Complete terms in LICENSE.txt
---

# Workflows

Mistral Workflows is a durable-execution platform: a Python framework (`mistralai.workflows`) whose workflows and activities survive crashes, retry automatically, and run from seconds to years, against a hosted control plane that schedules, streams, and traces them. This skill owns the authoring surface — the determinism and import rules, activity timeouts and retries, worker discovery, the Mistral AI plugin API — and vendors the SDK documentation indexed under [Reference documentation](#reference-documentation). It does **not** own the HTTP execution routes (the `fastapi-workflows-auth` overlay), the schedule implementations (the `python -m cli schedules` command, from the Evals capability), or the Compose and Helm overlays (`docker-compose-*`, `helm-*`); it depends only on `core`.

## Where things live

| Path | What |
| --- | --- |
| `apps/worker/src/worker/workflows/` | Feature workflows land here (`<feature>.py`), one module per workflow. |
| `apps/worker/src/worker/entrypoints/` | `worker.py` (discover + serve) and `dev.py` (watchfiles hot-reload). |
| `apps/worker/{pyproject.toml,project.json}`, `apps/worker/tests/` | Pins `mistralai-workflows`; `serve` and `register-schedules` NX targets; discovery, unique-name and no-web-framework guardrail tests. |
| `mistralai_capabilities.workflows` (installed toolkit) | `client` SDK boundary, `encryption` payload codec, `cli.start`. |
| `packages/py/env/src/env/workflows.py` | `env.workflows` settings: `WORKFLOWS_BASE_URL`, `DEPLOYMENT_NAME`, `WORKFLOWS_ENCRYPTION_*`, activity retry defaults. |
| `tools/worker-schedules.sh` | `worker:register-schedules`; runs `python -m cli schedules` (shipped by the Evals capability) and self-skips when it is absent. |
| `deploy/docker/Dockerfile.worker` | `workflows`, `workflows-dev` and `default` image stages. |
| `.agents/skills/capability-workflows/{references,scripts}/` | This skill: the vendored SDK documentation indexed below, the `test_workflow.py` quick-test runner, and the Semgrep rules. |

Run `mistral apps dev --filter worker --json` from the app root. It starts the worker, so do not invoke the worker entrypoint yourself; the dev reloader picks up changes on the next file save. The worker auto-discovers every `@workflows.workflow.define` class in the `worker.workflows` package, so dropping a file in `apps/worker/src/worker/workflows/` is all that is needed — there is no registration list to update.

`MISTRAL_API_KEY`, `WORKFLOWS_BASE_URL`, `DEPLOYMENT_NAME`, and `WORKFLOWS_ENCRYPTION_*` live in the app-root `.env`, seeded by the installed capabilities. Set `MISTRAL_API_KEY` there; `DEPLOYMENT_NAME` defaults to `deployment-<app_name>-<user>`. The shared `env` package loads this file with `override=False`, so a value exported in your shell wins over the file. It locates the app root by walking up for a directory holding both `package.json` and `pyproject.toml`.

## Add a workflow

Drop a module in `apps/worker/src/worker/workflows/` — the worker discovers every `@workflows.workflow.define` class in the `worker.workflows` package. Workflow names must be unique.

```python
import mistralai.workflows as workflows

@workflows.workflow.define(name="my_workflow")
class MyWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, data: MyInput) -> MyOutput:
        ...
```

This skill targets the **`mistralai-workflows` SDK v3.15.0 and higher**, the floor `apps/worker/pyproject.toml` pins. The import style above is canonical; focused snippets may use `from mistralai.workflows import workflow, activity, ...` instead.

- Call activities directly (`await my_activity(args)`); timeouts and retries live on the `@activity(...)` decorator, not at the call site.
- **All network I/O and SDK calls belong in an activity.** The sandbox enforces determinism inside workflow code. This covers operations that reach outside the sandbox: network, filesystem, and `mistralai` calls. In-workflow helpers such as `workflow.wait_condition()` and `asyncio.sleep()` are fine; [Limitations](references/guides/limitations.mdx) lists what else is allowed in workflow code.
- **Never import `temporalio` directly.** The SDK re-exports everything user code needs, so workflows stay portable and deterministic: `workflow.now()` / `workflow.uuid4()` / `workflow.random()` replace `datetime.now()`, `uuid.uuid4()`, and `random`; `workflow.wait_condition()`, `workflow.continue_as_new()`, and `workflow.execute_workflow()` drive control flow; `activity_heartbeat()` heartbeats from inside an activity; `WorkflowError`, `ActivityError`, and `ParentClosePolicy` come from `mistralai.workflows` too. Escape hatches are `workflow.unsafe.imports_passed_through()` and `workflow.unsafe.skip_determinism_enforcement()`.
- **Calling Mistral:** prefer the plugin activities (`mistralai_chat_complete`, `mistralai_ocr`, `mistralai_embeddings`, `chat_parse_to_model`, …; see [Workflows Plugins](references/guides/workflows-plugins.mdx)) — they are sandbox-safe. Use the raw `mistralai.client.Mistral` only when no plugin fits, and import it inside the activity that uses it: a module-level import pulls in `httpx`, which the sandbox rejects at worker startup (see [Limitations](references/guides/limitations.mdx)). Hoist it to module scope only under `workflow.unsafe.imports_passed_through()`.
- **Driving executions from application code:** build the client from `mistralai_capabilities.workflows.client`, which also re-exports the vendor response models (`WorkflowExecutionResponse`, `ScheduleDefinition`, …) — do not import them from `mistralai` directly. Every call targets `WORKFLOWS_BASE_URL`. See [Python SDK](references/getting-started/python-sdk.mdx).

## Test & lint before done

Run the project's static checks from the app root before reporting a workflow as done. With the Code quality capability installed:

- `bunx nx run quality:lint` — Ruff lint checks
- `bunx nx run quality:fmt-check` — Ruff formatting checks (`bunx nx run quality:fix` applies formatting and lint fixes)
- `bunx nx run quality:typecheck` — ty static type checking

`bun run check` builds the app and runs the installed capabilities' check targets. Install the Testing capability to include its test suite. Run the advisory workflow rules separately:

```bash
uvx semgrep --config .agents/skills/capability-workflows/scripts/linting/rules apps/worker/src/worker/workflows
```

Then do a test run with sample inputs, using the `test_workflow.py` script:

```bash
cd apps/worker
uv run --all-packages python ../../.agents/skills/capability-workflows/scripts/test_workflow.py <workflow_file> --input '{"key": "value"}' [--timeout 15]
```

Keep timeouts tight — a hanging test wastes more time than a false timeout. Defaults: `--timeout 15` seconds for the quick-test script, `execution_timeout=timedelta(seconds=10)` and `asyncio.wait_for(..., 15)` in pytest, the latter always slightly above the former. Raise them proportionally for a workflow you know is long-running (multi-step agent, large data processing), and only once you see a legitimate timeout failure — not preemptively.

**Never report a workflow as done before both the static checks and a test run pass.** Skipping them ships workflows that are non-deterministic, do I/O outside activities, or fail their first integration test.

## Gotchas

- The entrypoint's type hints **are** the API schema: the `fastapi-workflows-auth` overlay reflects them to build the HTTP route, and `workflow-start` validates input against them before dispatch. An entrypoint taking a bare `str` is rejected — take a Pydantic model.
- Activity retry defaults come from `env.workflows`: 3 attempts for reads, 1 for mutations (so a partially applied write is never replayed), backoff coefficient 2.0. Override per activity on `@activity(...)`.
- Payload encryption has two halves — the worker codec and the client hook share one cached config (`WORKFLOWS_ENCRYPTION_MODE`, `_KEY`, `_PREVIOUS_KEY`), so a `full` worker against an unconfigured client fails silently. The toolkit **refuses** the SDK's own `TEMPORAL_PAYLOAD_ENCRYPTION__*` variables, because two sources of truth would disagree. The default is `off`; the generated `.env` ships `partial`. See [Payload Encoding](references/guides/payload-encoding.mdx).
- Deploy the worker with `mistral apps deploy`. It deploys the worker module marked `"platform": "workflows"` as a managed workflow deployment named `<app>-<module>`, at the current commit, on the Mistral Cloud backend, and waits for the rollout. Push the commit first. Dispatch to it with `DEPLOYMENT_NAME=<app>-<module> uv run workflow-start --workflow <name> --input '...'`. See [Managed Deployments](references/guides/managed-deployments.mdx).

## Reference documentation

### Getting Started

- **[Introduction](references/getting-started/introduction.mdx)**: Overview of Mistral Workflows and its core architecture
- **[Value Proposition](references/getting-started/value-proposition.mdx)**: What the platform gives you over hand-rolled orchestration — durable-execution foundations, the DX shortcuts, and the complete feature list
- **[Installation](references/getting-started/installation.mdx)**: Guide to installing and setting up the Workflows framework (CLI scaffolding, optional deps)
- **[Core Concepts](references/getting-started/core-concepts.mdx)**: Workflows, activities, workers, executions vs runs
- **[Python SDK](references/getting-started/python-sdk.mdx)**: Programmatic API via the `mistralai` client (`client.workflows.*`)
- **[Your First Workflow](references/getting-started/your-first-workflow.mdx)**: Step-by-step guide to creating your first workflow

### Guides

- **[Workflows](references/guides/workflows.mdx)**: Creating workflows, determinism enforcement (sandbox), input types, timeouts, signals/queries/updates, child workflows, continue-as-new
- **[Activities](references/guides/activities.mdx)**: Timeouts, retries, heartbeats, local activities, sticky sessions, nested activities
- **[Workflows Exception Handling](references/guides/workflows-exception.mdx)**: WorkflowsException, ErrorCode enum, factory methods
- **[Error Codes](references/guides/error-codes.mdx)**: API error codes WF_1000-WF_1600 with HTTP status, description, and resolution
- **[Signals, Queries, and Updates](references/guides/signals-queries-updates.mdx)**: Workflow communication patterns with input validation
- **[Scheduling](references/guides/scheduling.mdx)**: Cron expressions, ScheduleDefinition, SchedulePolicy, overlap handling
- **[Dependency Injection](references/guides/dependency-injection.mdx)**: FastAPI-style Depends() pattern
- **[Streaming](references/guides/streaming.mdx)**: Task API, token streaming, progress updates
- **[Streaming Consumption](references/guides/streaming-consumption.mdx)**: `client.workflows.events.get_stream_events_async()`, NATS subjects, SSE API
- **[Concurrency](references/guides/concurrency.mdx)**: execute_activities_in_parallel() with List/Chain/Offset executors
- **[Rate Limiting](references/guides/rate-limiting.mdx)**: Distributed rate limiting across workers
- **[Handling Large Data](references/guides/handling-large-data.mdx)**: OffloadableField, blob storage (S3/Azure/GCS)
- **[Payload Encoding](references/guides/payload-encoding.mdx)**: Payload offloading, AES-GCM encryption, key rotation
- **[Observability](references/guides/observability.mdx)**: OpenTelemetry traces, trace sampling
- **[Durable Agents](references/guides/durable-agents.mdx)**: Agent, Runner, RemoteSession/LocalSession, MCP, multi-agent handoffs
- **[Connectors](references/guides/connectors.mdx)**: Call third-party tools (GitHub, Notion, Slack, ...) from a workflow or give them to an agent, without holding the service's credentials
- **[Conversational Workflows: Inputs](references/guides/assist-workflows.mdx)**: Getting started, ChatInput/timeout, structured form inputs and field types, confirmation inputs, todo list
- **[Conversational Workflows: Rich Output & UI](references/guides/assist-workflows-output.mdx)**: Streaming agent responses, rich outputs/canvas, canvas editing HITL, rich UI components, tool UI states
- **[Conversational Workflows: Platform Integration](references/guides/assist-workflows-platform.mdx)**: Publish in Vibe, tagging input variants, error handling, structured content, complete example
- **[Local Execution](references/guides/local-execution.mdx)**: No-infra dev mode with Pydantic model params
- **[Limitations](references/guides/limitations.mdx)**: System constraints, determinism rules, sandbox import restrictions (module-level non-deterministic imports + `imports_passed_through`), I/O and heavy work belongs in activities, execution-history limits
- **[Workflows Plugins](references/guides/workflows-plugins.mdx)**: Mistral AI plugin (calling chat / structured-output / embeddings / OCR models), Webhook plugin, Nuage plugin, custom plugins
- **[Deployment Patterns](references/guides/_deployment-patterns.mdx)**: Best practices for deploying workflows
- **[Managed Deployments](references/guides/managed-deployments.mdx)**: `mistral apps deploy` / `workflow-start` for hosting the worker on the Mistral platform from the repo, deployment names, build secrets for private indexes, dispatching to the deployed worker
- **[Migration v2 to v3](references/guides/migration-v2-to-v3.mdx)**: Breaking changes and upgrade steps from SDK v2 through v3.4.0

### Testing & Diagnostics

- **[Testing Workflows](references/guides/testing.md)**: Integration testing with `create_test_worker`, hang prevention, sandbox pitfalls
- **[Diagnostics](references/guides/diagnostics.md)**: Run `wf-diagnose` locally or on Kubernetes to collect a diagnostic report for support triage

### Internal References

Additional patterns and utilities not covered in the official docs:

- **[Execution IDs](references/execution_ids.md)**: Generate deterministic execution IDs for child workflows
- **[Pipeline Pattern](references/pipeline_pattern.md)**: Build multi-step workflows with declarative StepSpec definitions
- **[Workflow Testing](references/workflow_testing.md)**: Ensure workflow classes are properly registered in workers
