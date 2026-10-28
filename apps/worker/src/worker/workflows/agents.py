"""Agents: the orchestrator (``worker.agents.agent``) promoted to its durable session workflow.

The orchestrator is built in code (``worker/agents/agent.py``) and runs on the Unified Harness.
Subagents are unsupported there, so its ``Harness`` absorbs every installed capability's tools,
connectors, and the guardrail hook (see ``mistralai_capabilities.agents.assembly``). This app serves no execution
routes; a chat turn is a session on the vibe_agents control plane, forwarded from
``routers/api/v1/chat/`` and stored nowhere (D29). The worker runs the deployment ``init/agents.py``
registers, bound to the session workflow below.
"""

from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    import httpx
    import structlog
    from env.agents import env as agents_env
    from env.mistral import env as mistral_env
    from env.observability import env as observability_env
    from mistralai.agents import agents
    from mistralai.client import Mistral
    from mistralai.client.errors import SDKError
    from mistralai.client.utils.retries import BackoffStrategy, RetryConfig

    # isort: split
    from worker.agents.agent import agent as _orchestrator


logger = structlog.get_logger("workflows.agents")

_PROMPT_PAGE_SIZE = 100
_MISTRAL_RETRY_CONFIG = RetryConfig(
    strategy="backoff",
    backoff=BackoffStrategy(initial_interval=100, max_interval=100, exponent=1.0, max_elapsed_time=100),
    retry_connection_errors=True,
)


def _resolve_registry_content(client: Mistral) -> str | None:
    """Resolve configured prompt content without making worker startup depend on Studio."""
    page_token: str | None = None
    try:
        while True:
            page = client.beta.prompts.list(
                page_size=_PROMPT_PAGE_SIZE,
                page_token=page_token,
                server_url=observability_env.observability_api_base_url.rstrip("/"),
                timeout_ms=int(agents_env.prompt_registry_timeout_seconds * 1000),
                retries=_MISTRAL_RETRY_CONFIG,
            )
            if page is None:
                return None
            match = next(
                (prompt for prompt in page.result.data or [] if prompt.name == agents_env.prompt_registry_name),
                None,
            )
            if match is not None:
                if not match.id:
                    return None
                resolved = client.beta.prompts.get(
                    prompt_id=match.id,
                    alias=agents_env.prompt_registry_alias,
                    server_url=observability_env.observability_api_base_url.rstrip("/"),
                    timeout_ms=int(agents_env.prompt_registry_timeout_seconds * 1000),
                    retries=_MISTRAL_RETRY_CONFIG,
                )
                content = resolved.definition.content if resolved.definition is not None else None
                return content if isinstance(content, str) and content.strip() else None
            page_token = page.result.next_page_token
            if not page_token:
                return None
    except (SDKError, httpx.HTTPError, AttributeError, KeyError, TypeError, ValueError):
        return None


def _with_registry_instructions(agent: agents.Agent) -> agents.Agent:
    """``agent``, running the registry's prompt when there is one to run.

    ``to_workflow()`` bakes ``instructions`` at promotion time, so the prompt must be chosen here and
    the resolve is synchronous. Use ``model_copy`` to carry the private ``_bundle`` (the assembled
    harness). On any failure, return ``agent`` unchanged, because ``instructions.md`` is the seed the
    registry version descends from.
    """
    if not agents_env.prompt_registry_enabled:
        return agent
    if not mistral_env.mistral_api_key:
        content = None
    else:
        client = Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)
        content = _resolve_registry_content(client)
    if content is None:
        logger.warning(
            "prompt registry unreachable or empty; falling back to instructions.md",
            prompt=agents_env.prompt_registry_name,
            alias=agents_env.prompt_registry_alias,
        )
        return agent
    logger.info(
        "orchestrator prompt sourced from the registry",
        prompt=agents_env.prompt_registry_name,
        alias=agents_env.prompt_registry_alias,
        characters=len(content),
    )
    return agent.model_copy(update={"instructions": content})


# The orchestrator, exported so the optimizer can derive per-candidate agents from it with
# `model_copy`. Read-only by convention: mutating it would change what the promoted workflow class
# below already captured.
orchestrator_agent = _with_registry_instructions(_orchestrator)

# One project, one durable Vibe Agents session workflow. `type="session"` is what the vibe_agents
# control plane dispatches to and what `/chat` uses. `agents` is a frozen wire identifier; renaming
# it fails replay of in-flight executions. The Unified Harness has no `type="chat"` promotion (the
# eval harness that used it now drives the agent through a session instead).
AgentsSessionWorkflow = orchestrator_agent.to_workflow(name="agents", type="session")
