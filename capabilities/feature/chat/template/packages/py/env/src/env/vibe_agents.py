"""Settings for the agents session API, which backs the ``/chat`` surface.

Chat reaches the agents API at ``/v2/agents`` the same way every other capability reaches Mistral:
on the caller's credential where the deployment installs one, on ``MISTRAL_API_KEY`` where it does
not. Tenancy is resolved from whichever credential authenticates the call, so nothing here names an
organisation, a workspace or a customer. See ``mistralai_capabilities.chat.vibe.client``.
"""

from typing import Self

from pydantic import model_validator

from env._base import BaseEnv

# The platform's own session agent. Chat can front it, but it runs on the platform's deployment,
# so this app's orchestrator and every tool it assembles are unreachable from /chat when it does.
BUILTIN_AGENT_NAME = "nuage-session"


class Env(BaseEnv):
    # Which agent the /chat mount fronts, and the mount's 404 discriminator: upstream scopes a
    # session by principal but not agent, so this mount rejects a session started under another
    # agent (D3). Unset (or blank), it is this deployment's own agent, named after DEPLOYMENT_NAME:
    # `cli agents` registers that name against the `agents` session workflow this app's worker
    # serves, so /chat runs this app's orchestrator. Set `nuage-session` to front the platform's
    # builtin agent instead (no worker needed, but none of this app's tools either).
    vibe_agents_agent_name: str = ""

    # The worker's task queue (owned by the workflows capability). Read here only to derive the
    # default agent name, so one deployment identity names both the worker and its chat agent.
    deployment_name: str | None = None

    # Not a free label: upstream resolves it against its own registry of applications and answers
    # `400 Unknown application` for anything it does not know, so this cannot be set to whatever
    # names your deployment. `vibe_code_web` is the registered default that exists everywhere.
    # Changing it requires the application to be registered upstream first.
    vibe_agents_application_name: str = "vibe_code_web"

    # Read timeout for a single call. Deliberately not applied to the SSE tail, which is long-lived
    # by construction and would be killed by any read deadline.
    vibe_agents_timeout_seconds: float = 30.0

    @model_validator(mode="after")
    def _default_to_this_deployments_agent(self) -> Self:
        if not self.vibe_agents_agent_name and self.deployment_name:
            self.vibe_agents_agent_name = self.deployment_name
        return self

    @property
    def targets_builtin_agent(self) -> bool:
        return self.vibe_agents_agent_name == BUILTIN_AGENT_NAME


env = Env()
