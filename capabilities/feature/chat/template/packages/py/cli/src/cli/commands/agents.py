"""Bind this deployment's agent name to the session workflow its worker serves.

The control plane routes chat by agent name and cannot discover this deployment's worker, so
registration binds ``agent_name`` to this repo's workflow and worker. It runs once from the init
one-shot. The plane answers 409 without rebinding, so this step verifies the live binding and fails
on a mismatch. See ``_verify_existing_binding``.
"""

import asyncio
import os

import structlog
import typer
from env.mistral import env as mistral_env
from env.vibe_agents import BUILTIN_AGENT_NAME
from env.vibe_agents import env as vibe_env
from mistralai_capabilities.chat.vibe.client import (
    VibeAgentsNotConfiguredError,
    decode,
    list_agents,
    register_agent,
)

logger = structlog.get_logger("init.agents")
app = typer.Typer()
INIT_STEP = True  # wired into the deployment init chain (compose services + Helm Jobs)

# The name of the session-type promotion in `workflows/agents.py`. A frozen wire identifier: the
# control plane stores it, so changing it here without changing it there points every new session
# at a workflow the worker does not serve.
_SESSION_WORKFLOW_NAME = "agents"


@app.command(name="agents", help=__doc__)
def _run() -> None:
    asyncio.run(main())


async def main() -> None:
    # Registration is the deployment acting on itself, outside any request, so it goes on the
    # app's own key rather than a caller's credential.
    if not mistral_env.mistral_api_key:
        logger.info("MISTRAL_API_KEY is not configured; skipping agent registration")
        return
    if vibe_env.targets_builtin_agent:
        # The builtin belongs to the platform's own workspace and is already registered. Trying
        # to claim that name would 409 against something this deployment does not own, so there
        # is nothing to register. Say loudly what that costs: /chat then runs on the platform's
        # deployment, and nothing this app contributes to its orchestrator is reachable from it.
        logger.warning(
            "VIBE_AGENTS_AGENT_NAME is the platform builtin; /chat will NOT use this app's "
            "orchestrator or any of its tools. Unset VIBE_AGENTS_AGENT_NAME to register this "
            "deployment's own agent.",
            agent=BUILTIN_AGENT_NAME,
        )
        return

    deployment_name = os.environ.get("DEPLOYMENT_NAME")
    if not deployment_name:
        raise VibeAgentsNotConfiguredError("DEPLOYMENT_NAME is required to register an agent")
    if not vibe_env.vibe_agents_agent_name:
        raise VibeAgentsNotConfiguredError("VIBE_AGENTS_AGENT_NAME resolved to nothing; set it or DEPLOYMENT_NAME")

    response = await register_agent(
        agent_name=vibe_env.vibe_agents_agent_name,
        workflow_name=_SESSION_WORKFLOW_NAME,
        deployment_name=deployment_name,
    )
    if response.status_code == 409:
        await _verify_existing_binding(agent_name=vibe_env.vibe_agents_agent_name, deployment_name=deployment_name)
        return
    response.raise_for_status()
    logger.info(
        "agent registered; /chat fronts this app's orchestrator",
        agent=vibe_env.vibe_agents_agent_name,
        workflow=_SESSION_WORKFLOW_NAME,
        deployment=deployment_name,
        registered=decode(response),
    )


class StaleAgentBindingError(RuntimeError):
    """Raised when the registered agent points somewhere this deployment does not serve."""


async def _verify_existing_binding(*, agent_name: str, deployment_name: str) -> None:
    """Confirm the name already taken in this workspace is bound to this deployment.

    The control plane has no rebind: registering an existing name answers 409 and changes nothing.
    Treating that as success is dangerous, because a renamed deployment keeps dispatching chat to a
    worker that no longer runs, with no error. So the 409 is verified and a mismatch fails the step.
    """
    listing = decode(await list_agents())
    existing = next(
        (item for item in (listing or {}).get("items", []) if item.get("agent_name") == agent_name),
        None,
    )
    if existing is None:
        # Registration was refused for a name this workspace cannot see: the name belongs to
        # another workspace, or to a builtin. Either way this deployment does not own it.
        raise StaleAgentBindingError(
            f"Agent {agent_name!r} is already taken but is not visible in this workspace. "
            "Choose a different VIBE_AGENTS_AGENT_NAME."
        )

    bound = (existing.get("workflow_name"), existing.get("deployment_name"))
    if bound != (_SESSION_WORKFLOW_NAME, deployment_name):
        raise StaleAgentBindingError(
            f"Agent {agent_name!r} is registered to {bound[0]!r} on {bound[1]!r}, but this deployment "
            f"serves {_SESSION_WORKFLOW_NAME!r} on {deployment_name!r}. The control plane cannot rebind: "
            f"delete the agent (DELETE /agents/{existing.get('agent_id')}) and re-run this step, or pick a "
            "different VIBE_AGENTS_AGENT_NAME for this deployment."
        )

    logger.info(
        "agent already registered to this deployment",
        agent=agent_name,
        workflow=_SESSION_WORKFLOW_NAME,
        deployment=deployment_name,
        # False here is not an error: it means no worker is polling yet, which is ordinary when
        # init runs beside a worker that is still starting.
        is_active=existing.get("is_active"),
    )
