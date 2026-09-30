"""The chat session surface, as one ``VibeAgentsRouter`` mount.

This module is the index of ``chat/``, so it serves ``/api/v1/chat`` with no ``prefix``. ``agent``
comes from settings: by default it is this deployment's own agent (named after ``DEPLOYMENT_NAME``),
which ``cli agents`` registers against the worker's session workflow, and an operator may point it at
the platform builtin instead. It is also the discriminator each id-addressed route re-checks, so
repointing it makes the previous agent's sessions unreachable. ``name`` is the operation-id stem.
"""

from env.vibe_agents import env
from mistralai_capabilities.chat.vibe.router import VibeAgentsRouter

router = VibeAgentsRouter(agent=env.vibe_agents_agent_name, name="chat")
